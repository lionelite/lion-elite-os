'use strict';

// Send-safety rules that need no database: the server-side sending window
// (EST and EDT), pacing, the New York outreach day, and how provider outcomes
// are classified (a timeout is not a rejection).

const test = require('node:test');
const assert = require('node:assert/strict');

const { windowState, pacedGapMs, sendWindow } = require('../lib/outreach/send-cap');
const { dateKey } = require('../lib/postgres-prospect-store');
const { sendEmail, rateLimitHeaders } = require('../lib/email-delivery');

test('window: 09:00-15:00 New York by default, correct in EST and EDT, fails closed when malformed', () => {
  const at = t => windowState(new Date(t), {});
  // November (EST, UTC-5)
  assert.equal(at('2026-11-23T13:59:59Z').open, false, '8:59 AM EST');
  assert.equal(at('2026-11-23T14:00:00Z').open, true, '9:00 AM EST');
  assert.equal(at('2026-11-23T19:59:00Z').open, true, '2:59 PM EST');
  assert.equal(at('2026-11-23T20:00:00Z').open, false, '3:00 PM EST');
  // July (EDT, UTC-4)
  assert.equal(at('2026-07-15T12:59:00Z').open, false, '8:59 AM EDT');
  assert.equal(at('2026-07-15T13:00:00Z').open, true, '9:00 AM EDT');
  assert.equal(at('2026-07-15T19:00:00Z').open, false, '3:00 PM EDT');
  // DST transition days
  assert.equal(at('2026-03-08T14:30:00Z').open, true, 'spring-forward day, 10:30 EDT');
  assert.equal(at('2026-11-01T13:30:00Z').open, false, 'fall-back day, 8:30 EST');
  assert.equal(at('2026-11-23T14:00:00Z').msLeft, 6 * 3600_000);
  // Configurable; malformed or inverted fails closed.
  assert.equal(windowState(new Date('2026-11-23T04:00:00Z'), { OUTREACH_SEND_WINDOW: '09:00-23:00' }).open, false, '11 PM EST: window closed');
  assert.equal(windowState(new Date('2026-11-23T02:30:00Z'), { OUTREACH_SEND_WINDOW: '09:00-23:00' }).open, true, '9:30 PM EST');
  assert.equal(windowState(new Date('2026-11-23T15:00:00Z'), { OUTREACH_SEND_WINDOW: 'all day' }).open, false);
  assert.equal(sendWindow({ OUTREACH_SEND_WINDOW: '15:00-09:00' }).valid, false);
});

test('pacing spreads what is left over what is left of the window, never below the 30-90 s jitter', () => {
  const sixHours = 6 * 3600_000;
  assert.equal(pacedGapMs({ remainingAllowance: 150, msLeft: sixHours, random: () => 0 }), Math.floor((sixHours * 0.9) / 150));
  assert.equal(pacedGapMs({ remainingAllowance: 150, msLeft: 5 * 60_000, random: () => 0 }), 30_000, 'behind schedule: the jitter floor');
  assert.equal(pacedGapMs({ remainingAllowance: 1, msLeft: sixHours, random: () => 0 }), 10 * 60_000, 'never more than 10 minutes');
  assert.equal(pacedGapMs({ remainingAllowance: 0, msLeft: sixHours, random: () => 0 }), 30_000);
});

test('the outreach day is the New York calendar day, across midnight UTC and DST', () => {
  assert.equal(dateKey(new Date('2026-11-23T03:30:00Z')), '2026-11-22', '10:30 PM EST is still the 22nd');
  assert.equal(dateKey(new Date('2026-11-23T05:00:00Z')), '2026-11-23', 'midnight EST');
  assert.equal(dateKey(new Date('2026-07-16T03:59:00Z')), '2026-07-15', '11:59 PM EDT');
  assert.equal(dateKey(new Date('2026-03-08T04:59:00Z')), '2026-03-07', 'night before spring-forward');
  assert.equal(dateKey(new Date('2026-11-01T04:30:00Z')), '2026-11-01', 'fall-back night, 12:30 AM EDT');
});

test('provider outcomes: only a definitive 4xx is a rejection; timeouts, 429 and 5xx are uncertain', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { OUTREACH_SEND_ENABLED: 'true', RESEND_API_KEY: 'test-key', OUTREACH_FROM_EMAIL: 'from@example.com' });
  const draft = { recipient: 'info@clinic.example', subject: 's', body: 'b' };
  const respond = (status, body, headers = {}) => async () => ({
    ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers(headers),
  });
  try {
    const timeout = sendEmail({ draft, fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } });
    await assert.rejects(timeout, e => e.ambiguous === true && e.code === 'DELIVERY_OUTCOME_UNKNOWN');

    await assert.rejects(sendEmail({ draft, fetchImpl: respond(422, { message: 'invalid to' }) }), e => e.ambiguous === false && e.providerStatus === 422);
    await assert.rejects(sendEmail({ draft, fetchImpl: respond(500, {}) }), e => e.ambiguous === true);
    await assert.rejects(sendEmail({ draft, fetchImpl: respond(429, { name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota' }) }),
      e => e.ambiguous === true && e.quotaExceeded === true && e.providerStatus === 429);
    await assert.rejects(sendEmail({ draft, fetchImpl: respond(200, {}) }), e => e.ambiguous === true, '2xx without an id is not an acceptance');

    const ok = await sendEmail({ draft, fetchImpl: respond(200, { id: 're_1' }, { 'ratelimit-limit': '2', 'ratelimit-remaining': '1', 'x-resend-daily-quota': '17', 'set-cookie': 'nope' }) });
    assert.equal(ok.providerId, 're_1');
    assert.deepEqual(ok.providerLimits, { 'ratelimit-limit': '2', 'ratelimit-remaining': '1', 'x-resend-daily-quota': '17' }, 'limits recorded, nothing else');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assert.deepEqual(rateLimitHeaders(undefined), {});
});

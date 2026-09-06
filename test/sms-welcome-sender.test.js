'use strict';

// The path from a consent record to a text.
//
// This is the highest-risk code in the system: every failure mode here is a
// message to a real person who did not agree to it, at a time they did not
// agree to, or after they asked us to stop. So the tests are mostly about what
// must NOT send.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWelcomeCampaign, CAMPAIGN_ID } = require('../lib/sms/welcome-sender');

const NOON_UTC = Date.parse('2026-09-06T16:00:00Z'); // 12:00 in New York
const HOUR = 3600000;

const lead = extra => ({
  id: 'lead-1',
  lane: 'beauty-client',
  name: 'Sam',
  phone: '+16145550142',
  smsConsent: true,
  timezone: 'America/New_York',
  createdAt: new Date(NOON_UTC - HOUR).toISOString(),
  lastSmsSentAt: null,
  ...extra
});

function harness({ candidates, env = {}, halted = false } = {}) {
  const sent = [];
  const marked = [];
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return {
    sent, marked, restore,
    deps: {
      loadCandidates: async () => candidates,
      markSent: async (r, campaign) => marked.push([r.id, campaign]),
      sendMessage: async ({ to, body }) => { sent.push({ to, body }); return { sid: 'SM1' }; },
      reserveQuota: async () => true,
      isHalted: async () => halted,
      now: NOON_UTC
    }
  };
}

test('nothing sends unless SMS_SEND_ENABLED is true', async t => {
  const h = harness({ candidates: [lead()], env: { SMS_SEND_ENABLED: 'false' } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.blocked, 'SMS_SEND_ENABLED is not true');
  assert.deepEqual(h.sent, []);
});

test('the kill switch stops the campaign', async t => {
  const h = harness({ candidates: [lead()], env: { SMS_SEND_ENABLED: 'true' }, halted: true });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.blocked, 'kill switch engaged');
  assert.deepEqual(h.sent, []);
});

test('a consented lead in daylight receives one welcome', async t => {
  const h = harness({ candidates: [lead()], env: { SMS_SEND_ENABLED: 'true' } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.sent, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].to, '+16145550142');
  assert.match(h.sent[0].body, /Reply STOP to opt out\./);
  assert.match(h.sent[0].body, /^Lion Elite Beauty:/);
  assert.deepEqual(h.marked, [['lead-1', CAMPAIGN_ID]]);
});

test('nothing sends outside the recipient’s own quiet hours', async t => {
  // 16:00 UTC is midday in New York but 01:00 in Tokyo.
  const h = harness({ candidates: [lead({ timezone: 'Asia/Tokyo' })], env: { SMS_SEND_ENABLED: 'true' } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped[0].reason, 'outside_quiet_hours');
  assert.deepEqual(h.sent, []);
});

test('an unknown timezone is skipped rather than guessed', async t => {
  const h = harness({ candidates: [lead({ timezone: null })], env: { SMS_SEND_ENABLED: 'true' } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.skipped[0].reason, 'unknown_local_time');
  assert.deepEqual(h.sent, []);
});

test('no consent means no text, whatever else is true', async t => {
  const h = harness({ candidates: [lead({ smsConsent: false })], env: { SMS_SEND_ENABLED: 'true' } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.skipped[0].reason, 'no_sms_consent');
  assert.deepEqual(h.sent, []);
});

test('someone who opted out is never texted again', async t => {
  const h = harness({ candidates: [lead({ optedOut: true })], env: { SMS_SEND_ENABLED: 'true' } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.skipped[0].reason, 'opted_out');
  assert.deepEqual(h.sent, []);
});

test('a welcome is sent once and never repeated', async t => {
  const h = harness({
    candidates: [lead({ lastSmsSentAt: new Date(NOON_UTC - HOUR).toISOString() })],
    env: { SMS_SEND_ENABLED: 'true' }
  });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.skipped[0].reason, 'already_sent');
  assert.deepEqual(h.sent, []);
});

test('a lead who just submitted is left alone briefly', async t => {
  const h = harness({
    candidates: [lead({ createdAt: new Date(NOON_UTC - 30000).toISOString() })],
    env: { SMS_SEND_ENABLED: 'true' }
  });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.skipped[0].reason, 'too_soon_after_signup');
});

test('an invalid number is never dialled', async t => {
  const h = harness({ candidates: [lead({ phone: '6145550142' })], env: { SMS_SEND_ENABLED: 'true' } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign(h.deps);
  assert.equal(summary.skipped[0].reason, 'invalid_mobile');
  assert.deepEqual(h.sent, []);
});

test('the daily quota stops the run rather than overrunning it', async t => {
  const h = harness({ candidates: [lead(), lead({ id: 'lead-2', phone: '+16145550143' })], env: { SMS_SEND_ENABLED: 'true' } });
  t.after(h.restore);
  let allowance = 1;
  const summary = await runWelcomeCampaign({ ...h.deps, reserveQuota: async () => allowance-- > 0 });
  assert.equal(summary.sent, 1);
  assert.ok(summary.skipped.some(s => s.reason === 'daily_quota_reached'));
});

test('a dry run selects and renders without sending or marking', async t => {
  const h = harness({ candidates: [lead()], env: { SMS_SEND_ENABLED: null } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign({ ...h.deps, dryRun: true });
  assert.equal(summary.sent, 1, 'it reports what it would send');
  assert.deepEqual(h.sent, [], 'but sends nothing');
  assert.deepEqual(h.marked, [], 'and marks nothing');
  assert.match(summary.skipped.find(s => s.reason === 'dry_run').body, /Lion Elite Beauty/);
});

test('a send failure does not mark the lead as contacted', async t => {
  const h = harness({ candidates: [lead()], env: { SMS_SEND_ENABLED: 'true' } });
  t.after(h.restore);
  const summary = await runWelcomeCampaign({
    ...h.deps,
    sendMessage: async () => { throw new Error('twilio 500'); }
  });
  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped.find(s => s.reason === 'send_failed').detail, 'twilio 500');
  assert.deepEqual(h.marked, [], 'an unsent lead must stay eligible');
});

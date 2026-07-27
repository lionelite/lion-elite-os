'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SMS_CAMPAIGNS, assertSafeguards, withinQuietHours, getSmsCampaign } = require('../lib/sms/sms-campaigns');
const { buildReorderSms, segments, OPT_OUT } = require('../lib/sms/sms-message');
const { selectSmsRecipients, hasValidMobile } = require('../lib/sms/sms-selectors');

// ---- registry / safeguard invariants ----

test('the SMS campaign keeps every TCPA + outreach safeguard and is research-only', () => {
  const c = getSmsCampaign('client_research_reorder_sms');
  assert.equal(c.complianceMode, 'research-only');
  for (const k of ['consentRequired', 'optOut', 'quietHours', 'suppressionCheck', 'dailyQuota', 'killSwitch']) {
    assert.equal(c.safeguards[k], true, `missing safeguard ${k}`);
  }
});

test('a campaign missing consent/opt-out/quiet-hours is rejected', () => {
  assert.throws(() => assertSafeguards({
    id: 'bad', audienceType: 'consumer', complianceMode: 'research-only',
    safeguards: { suppressionCheck: true, dailyQuota: true, killSwitch: true }
  }), /cannot skip safeguards: consentRequired, optOut, quietHours/);
});

test('withinQuietHours enforces 8am–9pm local, fails closed on unknown', () => {
  assert.equal(withinQuietHours(8), true);
  assert.equal(withinQuietHours(20), true);
  assert.equal(withinQuietHours(21), false);
  assert.equal(withinQuietHours(7), false);
  assert.equal(withinQuietHours(undefined), false);
});

// ---- message builder ----

test('reorder SMS is RUO-compliant, brand-identified, and carries STOP', () => {
  const msg = buildReorderSms({ firstName: 'Sam', reorderUrl: 'https://lionelitewellness.com/r' });
  assert.equal(msg.approved, true, JSON.stringify(msg.compliance.blockers));
  assert.match(msg.body, /Lion Elite Wellness/);
  assert.match(msg.body, /laboratory research purposes only/);
  assert.match(msg.body, /Reply STOP to opt out\./);
  assert.equal(msg.body.includes(OPT_OUT), true);
});

test('reorder SMS contains no human-use / dosing / benefit language', () => {
  const { body } = buildReorderSms({ firstName: 'Sam' });
  assert.doesNotMatch(body, /inject|dose|\bmg\b|your protocol|take it|boost|improve your|weight loss/i);
});

test('segments() counts SMS segments', () => {
  assert.equal(segments('short'), 1);
  assert.equal(segments('x'.repeat(200)), 2);
});

// ---- recipient selection ----

const base = (over = {}) => ({
  prospectId: 'p', smsConsent: true, phone: '+12165551234',
  lastPurchaseAt: new Date(Date.parse('2026-07-27T00:00:00Z') - 60 * 86400000).toISOString(),
  localHour: 10, ...over
});

test('hasValidMobile requires E.164', () => {
  assert.equal(hasValidMobile({ phone: '+12165551234' }), true);
  assert.equal(hasValidMobile({ phone: '216-555-1234' }), false);
  assert.equal(hasValidMobile({ phone: '' }), false);
});

test('selectSmsRecipients enforces consent, opt-out, mobile, cooldown, quiet hours', () => {
  const now = Date.parse('2026-07-27T00:00:00Z');
  const day = 86400000;
  const recipients = [
    base({ prospectId: 'ok' }),
    base({ prospectId: 'noconsent', smsConsent: false }),
    base({ prospectId: 'stopped', smsOptedOut: true }),
    base({ prospectId: 'badphone', phone: '2165551234' }),
    base({ prospectId: 'recent', lastPurchaseAt: new Date(now - 10 * day).toISOString() }),
    base({ prospectId: 'night', localHour: 23 }),
    base({ prospectId: 'unknownhour', localHour: undefined }),
    base({ prospectId: 'neverbought', lastPurchaseAt: undefined })
  ];
  const { eligible, skipped } = selectSmsRecipients(recipients, { now });
  assert.deepEqual(eligible.map((r) => r.prospectId), ['ok']);
  const reason = (id) => skipped.find((s) => s.id === id).reason;
  assert.equal(reason('noconsent'), 'no_sms_consent');
  assert.equal(reason('stopped'), 'opted_out');
  assert.equal(reason('badphone'), 'invalid_mobile');
  assert.equal(reason('recent'), 'within_cooldown');
  assert.equal(reason('night'), 'outside_quiet_hours');
  assert.equal(reason('unknownhour'), 'unknown_local_time');
  assert.equal(reason('neverbought'), 'no_prior_purchase');
});

test('selectSmsRecipients can derive local hour via localHourFor', () => {
  const now = Date.parse('2026-07-27T00:00:00Z');
  const { eligible, skipped } = selectSmsRecipients([base({ localHour: undefined })], {
    now, localHourFor: () => 3 // 3am -> outside quiet hours
  });
  assert.equal(eligible.length, 0);
  assert.equal(skipped[0].reason, 'outside_quiet_hours');
});

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

// --- entity scoping --------------------------------------------------------
//
// Consent is given to a company, not to an operator running several. Under
// TCPA that is not a matter of preference, which is why it is checked before
// opt-out, suppression and every other per-recipient gate.

const { selectSmsRecipients: selectScoped } = require('../lib/sms/sms-selectors');

const consenting = (id, extra = {}) => ({
  id,
  smsConsent: true,
  phone: '+15555550123',
  lastPurchaseAt: '2020-01-01',
  localHour: 10,
  ...extra
});

test('without a sending entity, SMS selection behaves exactly as before', () => {
  const recipients = [
    consenting('a'),
    consenting('b', { smsConsentEntityId: 'lion_elite_wellness' }),
    consenting('c', { smsConsentEntityId: 'clinic_supply_llc' })
  ];
  assert.deepEqual(selectScoped(recipients).eligible.map(r => r.id), ['a', 'b', 'c']);
});

test('consent given to another entity is not consent for this one', () => {
  const recipients = [
    consenting('b', { smsConsentEntityId: 'lion_elite_wellness' }),
    consenting('c', { smsConsentEntityId: 'clinic_supply_llc' })
  ];
  const { eligible, skipped } = selectScoped(recipients, { entityId: 'lion_elite_wellness' });
  assert.deepEqual(eligible.map(r => r.id), ['b']);
  assert.deepEqual(skipped, [{ id: 'c', reason: 'consent_other_entity' }]);
});

test('a consent record predating entity separation is not treated as a mismatch', () => {
  // No entity recorded means it belongs to whoever was sending then, which is
  // the only entity that could have been sending. Skipping these would make
  // every existing consent permanently unusable.
  const { eligible } = selectScoped([consenting('a')], { entityId: 'lion_elite_wellness' });
  assert.deepEqual(eligible.map(r => r.id), ['a']);
});

test('entity scope is checked before the other per-recipient gates', () => {
  // A recipient who is both wrong-entity and opted out reports the entity
  // reason: the send was never this entity's to make in the first place.
  const recipient = consenting('c', { smsConsentEntityId: 'clinic_supply_llc', optedOut: true });
  const { skipped } = selectScoped([recipient], { entityId: 'lion_elite_wellness' });
  assert.deepEqual(skipped, [{ id: 'c', reason: 'consent_other_entity' }]);
});

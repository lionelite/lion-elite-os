'use strict';

// B2C lead capture.
//
// The SMS pipeline reads smsConsent in three places and refuses to send without
// it, and until this existed nothing could write it — the channel was gated
// shut with no key. These tests pin the key's shape: consent is only ever
// recorded when the person performed an affirmative act and the evidence for it
// exists. There is no path here that manufactures consent, and there must never
// be one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildCapture, normalizePhone, normalizeEmail, LANES } = require('../lib/leads/consent-capture');

const GOOD_DISCLOSURE = 'Up to 4 msgs/month. Msg & data rates may apply. Reply STOP to opt out.';
const base = extra => ({ lane: 'beauty-client', email: 'person@example.com', ...extra });

test('a full opt-in records consent with its evidence', () => {
  const capture = buildCapture(
    base({
      phone: '(614) 555-0142',
      name: 'Sam Rivera',
      emailMarketingConsent: true,
      smsMarketingConsent: true,
      smsConsentText: GOOD_DISCLOSURE
    }),
    { ip: '203.0.113.9', userAgent: 'Mozilla/5.0', now: '2026-09-06T12:00:00Z' }
  );
  assert.equal(capture.smsMarketingConsent, true);
  assert.equal(capture.smsConsentAt, '2026-09-06T12:00:00.000Z');
  assert.equal(capture.smsConsentText, GOOD_DISCLOSURE);
  assert.equal(capture.smsConsentIp, '203.0.113.9');
  assert.equal(capture.phone, '+16145550142', 'stored E.164 for the sender');
});

test('only an explicit true is consent', () => {
  for (const value of ['yes', 'true', 1, 'on', undefined, null]) {
    const capture = buildCapture(base({ phone: '6145550142', smsMarketingConsent: value, smsConsentText: GOOD_DISCLOSURE }), {});
    assert.equal(capture.smsMarketingConsent, false, `${JSON.stringify(value)} is not an affirmative act`);
    assert.equal(capture.smsConsentAt, null);
  }
});

test('SMS consent without the disclosure is refused', () => {
  assert.throws(
    () => buildCapture(base({ phone: '6145550142', smsMarketingConsent: true }), {}),
    /exact disclosure/
  );
});

test('SMS consent with an inadequate disclosure is refused', () => {
  assert.throws(
    () => buildCapture(base({ phone: '6145550142', smsMarketingConsent: true, smsConsentText: 'Get updates from us' }), {}),
    /missing required elements/
  );
});

test('SMS consent without a phone number is refused', () => {
  assert.throws(
    () => buildCapture(base({ smsMarketingConsent: true, smsConsentText: GOOD_DISCLOSURE }), {}),
    /requires a phone number/
  );
});

test('an unreadable phone number is refused rather than guessed', () => {
  // Guessing wrong means texting a stranger.
  assert.throws(() => buildCapture(base({ phone: '555-01' }), {}), /could not be read/);
  assert.equal(normalizePhone('12345'), '');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
});

test('the consent origin is observed, never submitted', () => {
  const capture = buildCapture(
    base({
      phone: '6145550142', smsMarketingConsent: true, smsConsentText: GOOD_DISCLOSURE,
      // A caller trying to dictate its own provenance.
      smsConsentIp: '9.9.9.9', smsConsentUserAgent: 'forged'
    }),
    { ip: '203.0.113.9', userAgent: 'real-agent' }
  );
  assert.equal(capture.smsConsentIp, '203.0.113.9');
  assert.equal(capture.smsConsentUserAgent, 'real-agent');
});

test('both lanes are accepted and anything else is refused', () => {
  for (const lane of Object.keys(LANES)) {
    assert.equal(buildCapture({ lane, email: 'a@b.co' }, {}).lane, lane);
  }
  assert.throws(() => buildCapture({ lane: 'purchased-list', email: 'a@b.co' }, {}), /lane must be one of/);
});

test('an invalid email is refused', () => {
  assert.equal(normalizeEmail('not-an-email'), '');
  assert.throws(() => buildCapture({ lane: 'beauty-client', email: 'nope' }, {}), /valid email/);
});

test('the capture surface offers no bulk or import path', () => {
  // A route that accepted a list would be a route that manufactured consent.
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'leads.js'), 'utf8');
  for (const forbidden of ['/import', '/bulk', '/upload']) {
    assert.ok(!route.includes(forbidden), `leads router must expose no ${forbidden} path`);
  }
});

test('the database refuses consent it has no evidence for', () => {
  // Application-level checks are not the only guard: the schema states it too.
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS captured_leads'));
  assert.ok(table.includes('sms_marketing_consent = false OR ('), 'schema must constrain SMS consent');
  assert.ok(table.includes('sms_consent_text IS NOT NULL'), 'consent requires the stored disclosure');
  assert.ok(table.includes('email_marketing_consent = false OR email_consent_at IS NOT NULL'));
});

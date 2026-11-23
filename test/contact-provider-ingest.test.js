'use strict';

// Licensed B2B contact-data ingest.
//
// The owner authorized licensed provider data on 2026-09-22 with three
// conditions that are legal requirements rather than preferences: B2B only,
// e-mail only (SMS needs TCPA consent a purchased number cannot carry), and
// provenance per record. These cover the refusals, because a record that gets
// in is a record that gets sent to.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyContactKind, classifyPhone, ingestRecord, ingestBatch
} = require('../lib/contacts/provider-ingest');

const licence = Object.freeze({
  providerId: 'apollo',
  licenceRef: 'APOLLO-2026-001',
  acquiredAt: '2026-09-24T00:00:00.000Z',
  region: 'US'
});

function record(overrides = {}) {
  return {
    contactName: 'Dana Reyes',
    title: 'Owner',
    companyName: 'Glow Med Spa',
    companyDomain: 'glowmedspa.com',
    email: 'dana@glowmedspa.com',
    linkedinUrl: 'https://www.linkedin.com/in/example',
    country: 'US',
    ...overrides
  };
}

test('a work address on the company domain is a business contact', () => {
  assert.equal(classifyContactKind('dana@glowmedspa.com', 'glowmedspa.com'), 'work_email');
  assert.equal(classifyContactKind('dana@mail.glowmedspa.com', 'glowmedspa.com'), 'work_email');
  assert.equal(classifyContactKind('dana@glowmedspa.com', 'https://www.glowmedspa.com/book'), 'work_email');
});

test('a role mailbox is a company contact even without a known domain', () => {
  assert.equal(classifyContactKind('info@glowmedspa.com', ''), 'company_general_email');
  assert.equal(classifyContactKind('appointments@spamiamibeach.com', 'other.com'), 'unverified_email');
  assert.equal(classifyContactKind('hello@anything.com', ''), 'company_general_email');
});

test('a free-mail address is a person, whoever the provider attached it to', () => {
  // Live example from the harvested store: an aesthetics business whose only
  // listed address was a personal Gmail. A B2B campaign must not send to it.
  assert.equal(classifyContactKind('brianfritze310@gmail.com', 'aventura-aesthetics.com'), 'personal_email');
  assert.equal(classifyContactKind('someone@yahoo.co.uk', 'acme.com'), 'personal_email');
  assert.equal(classifyContactKind('x@proton.me', 'acme.com'), 'personal_email');
});

test('a lookalike domain is not promoted to a work address', () => {
  // acme.co is not acme.com, and "probably corporate" is the reasoning that
  // lets a personal domain through.
  assert.equal(classifyContactKind('dana@acme.co', 'acme.com'), 'unverified_email');
  assert.equal(classifyContactKind('dana@notacme.com', 'acme.com'), 'unverified_email');
});

test('phone kind comes from the provider type, and an unknown type fails closed', () => {
  assert.equal(classifyPhone({ type: 'work_hq', sanitized_number: '+13055550100' }), 'company_phone');
  assert.equal(classifyPhone({ type: 'mobile', sanitized_number: '+13055550100' }), 'personal_phone');
  assert.equal(classifyPhone({ type: '', sanitized_number: '+13055550100' }), 'untyped_phone');
  assert.equal(classifyPhone({ type: 'carrier_pigeon', sanitized_number: '+13055550100' }), 'untyped_phone');
  assert.equal(classifyPhone({ type: 'work_hq', sanitized_number: '' }), null);
});

test('a work-email record is accepted and carries its provenance', () => {
  const { accepted, prospect, blockers } = ingestRecord(record(), { licence, env: {} });

  assert.deepStrictEqual(blockers, []);
  assert.equal(accepted, true);
  assert.equal(prospect.contactKind, 'work_email');
  assert.equal(prospect.email, 'dana@glowmedspa.com');
  assert.equal(prospect.provenance.providerId, 'apollo');
  assert.equal(prospect.provenance.licenceRef, 'APOLLO-2026-001');
  assert.equal(prospect.provenance.contactKind, 'work_email');
  assert.ok(prospect.provenance.recordedAt, 'stamped so erasure survives the next import');
});

test('a personal address is refused rather than imported', () => {
  const { accepted, prospect, blockers } = ingestRecord(
    record({ email: 'dana.reyes@gmail.com' }), { licence, env: {} }
  );

  assert.equal(accepted, false);
  assert.equal(prospect, null);
  assert.match(blockers.join(' '), /personal mailbox/i);
  assert.match(blockers.join(' '), /B2B only/i);
});

test('a phone from licensed data is never SMS-eligible', () => {
  // The authorization is explicit: licensed data feeds e-mail only, because
  // TCPA requires prior express written consent and a purchased number is
  // exactly what that prohibits.
  const { prospect } = ingestRecord(
    record({ phone_numbers: [{ type: 'work_hq', sanitized_number: '+13055550100' }] }),
    { licence, env: {} }
  );

  assert.equal(prospect.companyPhone, '+13055550100');
  assert.equal(prospect.smsEligible, false);
  assert.equal(prospect.smsConsent, false, 'recorded false, not absent — absent reads as unknown');
  assert.match(prospect.smsIneligibleReason, /TCPA/);
});

test('a revealed personal mobile is not taken as a company line', () => {
  const { prospect } = ingestRecord(
    record({ phone_numbers: [{ type: 'mobile', sanitized_number: '+13055550199' }] }),
    { licence, env: {} }
  );

  assert.equal(prospect.companyPhone, null, 'a person’s mobile is not a company phone');
});

test('the LinkedIn URL is an identifier and says so, not a channel', () => {
  // Automated LinkedIn connection requests and DMs are barred by LinkedIn's
  // User Agreement — a third party's terms, so not the owner's to waive. The
  // flag exists so whoever wires the next worker cannot read this as a target.
  const { prospect } = ingestRecord(record(), { licence, env: {} });

  assert.equal(prospect.linkedinUrl, 'https://www.linkedin.com/in/example');
  assert.equal(prospect.linkedinIsNotAChannel, true);
});

test('a record with no reachable contact point is refused', () => {
  const { accepted, blockers } = ingestRecord(
    record({ email: null, phone_numbers: [] }), { licence, env: {} }
  );

  assert.equal(accepted, false);
  assert.match(blockers.join(' '), /No contact point/i);
});

test('a missing licence reference is refused, not defaulted', () => {
  const { accepted, blockers } = ingestRecord(record(), {
    licence: { providerId: 'apollo', region: 'US' },
    env: {}
  });

  assert.equal(accepted, false);
  assert.ok(blockers.length, 'provenance is a condition of the authorization, not metadata');
});

test('an EU record without a lawful basis is refused', () => {
  // An unknown region must not default to the most permissive rules.
  const { accepted, blockers } = ingestRecord(
    record({ email: 'dana@glowmedspa.de', companyDomain: 'glowmedspa.de' }),
    { licence: { ...licence, region: 'EU' }, env: {} }
  );

  assert.equal(accepted, false);
  assert.match(blockers.join(' ').toLowerCase(), /lawful basis|basis/);
});

test('an EU record with a recorded lawful basis is accepted', () => {
  const { accepted } = ingestRecord(
    record({ email: 'dana@glowmedspa.de', companyDomain: 'glowmedspa.de' }),
    { licence: { ...licence, region: 'EU', lawfulBasis: 'legitimate_interests' }, env: {} }
  );

  assert.equal(accepted, true);
});

test('a quarantined provider stops importing without a deploy', () => {
  const { accepted, blockers } = ingestRecord(record(), {
    licence,
    env: { CONTACT_SOURCE_QUARANTINE: 'apollo' }
  });

  assert.equal(accepted, false);
  assert.match(blockers.join(' ').toLowerCase(), /quarantin/);
});

test('a batch reports what it refused instead of quietly shrinking', () => {
  // An import that silently drops most of a purchased file looks identical to
  // a small file, and the difference is money.
  const { prospects, refused, stats } = ingestBatch([
    record(),
    record({ contactName: 'B', email: 'b@gmail.com' }),
    record({ contactName: 'C', email: null, phone_numbers: [] }),
    record({ contactName: 'D', email: 'info@glowmedspa.com' })
  ], { licence, env: {} });

  assert.equal(stats.received, 4);
  assert.equal(stats.accepted, 2, 'the work address and the role mailbox');
  assert.equal(stats.refusedCount, 2);
  assert.equal(prospects.length, 2);
  assert.equal(refused.length, 2);
  assert.ok(Object.keys(stats.refusedByReason).length, 'refusals are grouped, not just counted');
  assert.equal(stats.smsEligible, 0, 'this route is e-mail only by authorization');
});

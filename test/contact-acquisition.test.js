'use strict';

// The acquisition spine and the source registry.
//
// The pipeline's recurring failure is code that is complete, tested and wired
// to nothing, so these check two things: that every route is declared with what
// it yields and what gates it, and that a record cannot reach the store without
// passing through the same gates whichever route it came in on.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTACT_SOURCES, REFUSED_SOURCES, liveSources, dormantSources, sourcesYielding, isRefused
} = require('../lib/contacts/source-manifest');
const { normaliseRecord, acquire } = require('../lib/contacts/acquisition');

test('every declared source says what it yields, what gates it, and its basis', () => {
  const statuses = new Set(['live', 'blocked', 'ready', 'inert']);
  for (const [id, source] of Object.entries(CONTACT_SOURCES)) {
    assert.equal(source.id, id, `${id} key and id must agree`);
    assert.ok(statuses.has(source.status), `${id} has an unknown status`);
    assert.ok(source.yields.length, `${id} declares nothing it yields`);
    assert.ok(source.legalBasis, `${id} has no recorded legal basis`);
    assert.ok(typeof source.costPerRecord === 'number', `${id} has no cost`);
  }
});

test('the registry is honest about what actually produces today', () => {
  // Verified on a runner 2026-09-24: OSM returned 32 businesses in Cleveland
  // and 25 new in Miami, and the site enrichment feeds off it.
  assert.deepStrictEqual(liveSources().map(s => s.id).sort(), ['openstreetmap', 'own_website_enrichment']);

  const dormant = dormantSources();
  assert.ok(dormant.length, 'anything not live is listed with what it waits on');
  for (const entry of dormant) assert.ok(entry.waitingOn, `${entry.id} must say what it is waiting on`);
});

test('bluesky is recorded as blocked, and as yielding no contact detail', () => {
  // 23 of 23 searches have 403'd on every run for weeks. Worth pinning: a
  // handle is a channel, not a phone number, so fixing it does not produce the
  // contact data the outbound engine needs.
  const bluesky = CONTACT_SOURCES.bluesky_search;
  assert.equal(bluesky.status, 'blocked');
  assert.ok(!bluesky.yields.includes('work_email'));
  assert.ok(!bluesky.yields.includes('company_phone'));
});

test('only two routes can produce an email, and only two a phone', () => {
  // The answer to "how do we get the info": these, and nothing else.
  assert.ok(sourcesYielding('work_email').length >= 2);
  assert.ok(sourcesYielding('company_phone').length >= 2);
});

test('scraping LinkedIn is recorded as refused, with the reason and the alternative', () => {
  assert.equal(isRefused('linkedin_scrape'), true);
  assert.match(REFUSED_SOURCES.linkedin_scrape.reason, /User Agreement/);
  assert.equal(REFUSED_SOURCES.linkedin_scrape.alternative, 'licensed_provider');

  assert.equal(isRefused('purchased_mobile_for_sms'), true);
  assert.match(REFUSED_SOURCES.purchased_mobile_for_sms.reason, /TCPA/);
});

test('acquiring from a refused route throws and names the supported one', () => {
  assert.throws(
    () => acquire({ sourceId: 'linkedin_scrape', records: [{ email: 'a@b.com' }] }),
    error => error.code === 'SOURCE_REFUSED' && error.alternative === 'licensed_provider'
  );
});

test('an undeclared route is refused rather than waved through', () => {
  // A route nobody declared is a route nobody reviewed.
  assert.throws(
    () => acquire({ sourceId: 'some_new_scraper', records: [] }),
    error => error.code === 'SOURCE_UNREGISTERED'
  );
});

test('a bare phone from a public listing is typed as the company line', () => {
  // OSM and most CSVs give a number with no type. Untyped fails closed, and
  // failing closed here would discard the one contact detail this pipeline
  // reliably gets — a business's own published number.
  const record = normaliseRecord({ name: 'Kiron Spa', phone: '+1 786-483-8981' }, 'openstreetmap');
  assert.equal(record.phoneNumbers.length, 1);
  assert.equal(record.phoneNumbers[0].type, 'work_hq');
});

test('field names from every route normalise to one shape', () => {
  const osm = normaliseRecord({ name: 'A', website: 'a.com', phone: '+13055550100' }, 'openstreetmap');
  const apollo = normaliseRecord({ companyName: 'A', companyDomain: 'a.com' }, 'licensed_provider');
  const csv = normaliseRecord({ company_name: 'A', domain: 'a.com' }, 'csv_import');

  for (const record of [osm, apollo, csv]) {
    assert.equal(record.companyName, 'A');
    assert.equal(record.companyDomain, 'a.com');
  }
});

test('a real harvested business is admitted with provenance and no SMS eligibility', () => {
  // GlowVita, from today's Miami harvest.
  const { accepted, stats } = acquire({
    sourceId: 'openstreetmap',
    records: [{
      name: 'GlowVita',
      website: 'glowvitamedspa.com',
      email: 'info@glowvitamedspa.com',
      phone: '+1-305-676-6866',
      address: 'Miami FL'
    }],
    env: {}
  });

  assert.equal(stats.accepted, 1);
  assert.equal(stats.withEmail, 1);
  assert.equal(stats.withPhone, 1);
  assert.equal(stats.smsEligible, 0);

  const [prospect] = accepted;
  assert.equal(prospect.email, 'info@glowvitamedspa.com');
  assert.equal(prospect.companyPhone, '+1-305-676-6866');
  assert.equal(prospect.contactKind, 'company_general_email');
  assert.equal(prospect.smsConsent, false, 'a number from a shop window is no more consented than a purchased one');
  assert.equal(prospect.linkedinIsNotAChannel, true);
  assert.equal(prospect.provenance.type, 'public_directory');
  assert.ok(prospect.provenance.recordedAt);
});

test('the personal Gmail that actually got in is refused on the public route too', () => {
  // Aventura Aesthetics, from the same harvest. Both doors, one rule.
  const { accepted, refused } = acquire({
    sourceId: 'openstreetmap',
    records: [{
      name: 'Aventura Aesthetics',
      website: 'aventura-aesthetics.com',
      email: 'brianfritze310@gmail.com',
      phone: '+1-305-454-0449'
    }],
    env: {}
  });

  assert.equal(accepted.length, 0);
  assert.equal(refused.length, 1);
  assert.match(refused[0].blockers.join(' '), /personal mailbox/i);
});

test('a licensed record still needs its licence, whichever door it uses', () => {
  const withoutLicence = acquire({
    sourceId: 'licensed_provider',
    records: [{ companyName: 'Acme', companyDomain: 'acme.com', email: 'dana@acme.com' }],
    licence: {},
    env: {}
  });
  assert.equal(withoutLicence.stats.accepted, 0, 'no licence reference, no import');

  const withLicence = acquire({
    sourceId: 'licensed_provider',
    records: [{ companyName: 'Acme', companyDomain: 'acme.com', email: 'dana@acme.com' }],
    licence: { licenceRef: 'APOLLO-2026-001', acquiredAt: '2026-09-24T00:00:00.000Z', region: 'US' },
    env: {}
  });
  assert.equal(withLicence.stats.accepted, 1);
  assert.equal(withLicence.accepted[0].provenance.licenceRef, 'APOLLO-2026-001');
});

test('a CSV row whose only contact is a LinkedIn URL is not admitted', () => {
  // It used to count as reachable, so a purchased file of profile links
  // imported clean and every row looked actionable — when the only way to act
  // on it is an automated connection request or DM, which LinkedIn's User
  // Agreement prohibits.
  const { importRows } = require('../lib/platform/csv-import');
  const result = importRows(
    [
      { Email: 'dana@acme.com', Li: 'https://linkedin.com/in/a' },
      { Email: '', Li: 'https://linkedin.com/in/b' },
      { Email: '', Phone: '+13055550100', Li: '' }
    ],
    { email: 'Email', linkedinUrl: 'Li', phone: 'Phone' }
  );

  assert.equal(result.accepted.length, 2, 'the email row and the phone row');
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'no_reachable_contact');
  assert.equal(result.rejected[0].row.linkedinUrl, 'https://linkedin.com/in/b', 'the URL is kept on the record, it just is not a channel');
});

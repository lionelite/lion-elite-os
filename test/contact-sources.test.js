const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOURCE_TYPES, LAWFUL_BASIS_REGIONS, BUSINESS_CONTACT_KINDS,
  evaluateSource, isApprovedSource, provenanceRecord, isQuarantined, quarantinedProviders,
} = require('../lib/contacts/sources');
const { validateProspect } = require('../lib/outreach-validation');

const LICENSED = {
  type: 'licensed_provider',
  providerId: 'exampleprovider',
  licenceRef: 'LIC-2026-0001',
  acquiredAt: '2026-09-01T00:00:00.000Z',
  region: 'US',
  contactKind: 'work_email',
  providerWarrantsLawfulSourcing: true,
};

test('a fully provenanced licensed B2B record is approved', () => {
  const result = evaluateSource(LICENSED, { env: {} });
  assert.equal(result.approved, true, result.blockers.join('; '));
  assert.equal(result.type, 'licensed_provider');
});

test('a licensed record without its licence reference is refused', () => {
  for (const field of ['providerId', 'licenceRef', 'acquiredAt']) {
    const source = { ...LICENSED };
    delete source[field];
    const result = evaluateSource(source, { env: {} });
    assert.equal(result.approved, false, `${field} must be required`);
    assert.ok(result.blockers.some((b) => b.includes(field)), `the blocker must name ${field}`);
  }
});

test('an unknown region fails closed rather than defaulting to permissive rules', () => {
  const source = { ...LICENSED };
  delete source.region;
  const result = evaluateSource(source, { env: {} });
  assert.equal(result.approved, false);
  assert.ok(result.blockers.some((b) => /region/i.test(b)));
});

test('EU/UK records need a recorded lawful basis; US records do not', () => {
  for (const region of LAWFUL_BASIS_REGIONS) {
    const withoutBasis = evaluateSource({ ...LICENSED, region }, { env: {} });
    assert.equal(withoutBasis.approved, false, `${region} must require a lawfulBasis`);
    const withBasis = evaluateSource({ ...LICENSED, region, lawfulBasis: 'legitimate_interests' }, { env: {} });
    assert.equal(withBasis.approved, true, `${region} with a basis should pass: ${withBasis.blockers.join('; ')}`);
  }
  assert.equal(evaluateSource({ ...LICENSED, region: 'US' }, { env: {} }).approved, true);
});

test('an unrecognised lawful basis is refused', () => {
  const result = evaluateSource({ ...LICENSED, region: 'UK', lawfulBasis: 'we really want to' }, { env: {} });
  assert.equal(result.approved, false);
  assert.ok(result.blockers.some((b) => /lawfulBasis/.test(b)));
});

test('the authorization is B2B only — a consumer address cannot enter this way', () => {
  for (const kind of ['personal_email', 'home_phone', 'mobile']) {
    const result = evaluateSource({ ...LICENSED, contactKind: kind }, { env: {} });
    assert.equal(result.approved, false, `${kind} must be refused`);
    assert.ok(result.blockers.some((b) => /B2B only/.test(b)));
  }
  for (const kind of BUSINESS_CONTACT_KINDS) {
    assert.equal(evaluateSource({ ...LICENSED, contactKind: kind }, { env: {} }).approved, true, kind);
  }
});

test('a missing contactKind warns rather than silently allowing a personal address through', () => {
  const source = { ...LICENSED };
  delete source.contactKind;
  const result = evaluateSource(source, { env: {} });
  assert.equal(result.approved, true, 'not a blocker — it is recorded at import');
  assert.ok(result.warnings.some((w) => /contactKind/.test(w)));
});

test('a quarantined provider is refused without touching other providers', () => {
  const env = { CONTACT_SOURCE_QUARANTINE: 'badlist, exampleprovider' };
  assert.deepEqual(quarantinedProviders(env), ['badlist', 'exampleprovider']);
  assert.equal(isQuarantined(LICENSED, env), true);
  const blocked = evaluateSource(LICENSED, { env });
  assert.equal(blocked.approved, false);
  assert.ok(blocked.blockers.some((b) => /quarantined/.test(b)));
  // A different provider is unaffected.
  assert.equal(evaluateSource({ ...LICENSED, providerId: 'goodlist' }, { env }).approved, true);
});

test('quarantine matching is case-insensitive and tolerates spacing', () => {
  assert.equal(isQuarantined({ providerId: 'Apollo' }, { CONTACT_SOURCE_QUARANTINE: ' apollo ' }), true);
  assert.equal(isQuarantined({ providerId: 'apollo' }, { CONTACT_SOURCE_QUARANTINE: '' }), false);
  assert.equal(isQuarantined({}, { CONTACT_SOURCE_QUARANTINE: 'apollo' }), false);
});

test('an unknown source type is refused, naming the approved set', () => {
  const result = evaluateSource({ type: 'scraped_from_linkedin' }, { env: {} });
  assert.equal(result.approved, false);
  assert.ok(result.blockers[0].includes('Unknown source type'));
  for (const type of Object.keys(SOURCE_TYPES)) assert.ok(result.blockers[0].includes(type));
});

test('a record with no origin at all is refused', () => {
  assert.equal(evaluateSource({}, { env: {} }).approved, false);
  assert.equal(evaluateSource(undefined, { env: {} }).approved, false);
});

test('a scraped-website record still needs its URL', () => {
  assert.equal(isApprovedSource({ type: 'public_website', url: 'https://acme.com' }, { env: {} }), true);
  assert.equal(isApprovedSource({ type: 'public_website' }, { env: {} }), false);
});

test('an inbound contact needs nothing beyond its type — they came to us', () => {
  assert.equal(isApprovedSource({ type: 'inbound' }, { env: {} }), true);
});

// Load-bearing: every prospect stored before this module existed uses the old
// shape, and failing them would halt the live pipeline.
test('the legacy source shape keeps working and says that it was inferred', () => {
  const legacy = { approved: true, url: 'https://elitegym.com' };
  const result = evaluateSource(legacy, { env: {} });
  assert.equal(result.approved, true, 'existing stored prospects must not start failing');
  assert.equal(result.type, 'public_website');
  assert.ok(result.warnings.some((w) => /Legacy source shape/.test(w)));
});

test('a legacy shape without explicit approval is still refused', () => {
  assert.equal(evaluateSource({ url: 'https://acme.com' }, { env: {} }).approved, false);
  assert.equal(evaluateSource({ approved: true }, { env: {} }).approved, false);
});

test('provenance is captured per record so erasure survives the next import', () => {
  const record = provenanceRecord({ ...LICENSED, region: 'uk', lawfulBasis: 'legitimate_interests' });
  assert.equal(record.providerId, 'exampleprovider');
  assert.equal(record.licenceRef, 'LIC-2026-0001');
  assert.equal(record.region, 'UK', 'region is normalised upper-case');
  assert.equal(record.lawfulBasis, 'legitimate_interests');
  assert.ok(record.recordedAt, 'when we recorded it, distinct from when it was acquired');
  assert.equal(record.acquiredAt, LICENSED.acquiredAt);
});

// ---- integration with the 16-check engine ----

const PASSING_PROSPECT = {
  id: 'p1',
  business: { name: 'Acme', domain: 'acme.com' },
  identityStatus: 'verified',
  identityConfidence: 0.95,
  duplicateStatus: 'clear',
  campaignEligibility: 'eligible',
  suppressionStatus: 'clear',
  lastVerifiedAt: new Date().toISOString(),
  qualificationScore: { percentage: 85 },
  personalization: { qualityScore: 85, evidenceCoverage: 0.95 },
  crmSyncStatus: 'synced',
  cadenceStatus: 'allowed',
  channel: 'email',
  complianceStatus: 'passed',
  contactCountInWindow: 0,
  messageVersionStatus: 'approved',
};
const POLICY = { approvedChannels: ['email'] };

test('a licensed record now passes approved_source — it could not before', () => {
  const result = validateProspect({ ...PASSING_PROSPECT, source: LICENSED }, POLICY, { env: {} });
  assert.equal(result.decision, 'outreach_approved', `failed: ${result.failedChecks.join(', ')}`);
});

test('a licensed record missing provenance fails at approved_source, and the reason is named', () => {
  const result = validateProspect(
    { ...PASSING_PROSPECT, source: { type: 'licensed_provider', providerId: 'exampleprovider' } },
    POLICY,
    { env: {} },
  );
  assert.equal(result.decision, 'validation_failed');
  assert.deepEqual(result.failedChecks, ['approved_source']);
});

test('buying a list does not bypass suppression or the other fifteen checks', () => {
  const suppressed = validateProspect(
    { ...PASSING_PROSPECT, source: LICENSED, suppressionStatus: 'suppressed', optOut: true },
    POLICY,
    { env: {} },
  );
  assert.equal(suppressed.decision, 'validation_failed');
  assert.ok(suppressed.failedChecks.includes('suppression_clear'));

  const unqualified = validateProspect(
    { ...PASSING_PROSPECT, source: LICENSED, qualificationScore: { percentage: 10 } },
    POLICY,
    { env: {} },
  );
  assert.ok(unqualified.failedChecks.includes('qualification_threshold'));
});

test('a quarantined provider fails validation end to end', () => {
  const result = validateProspect({ ...PASSING_PROSPECT, source: LICENSED }, POLICY, {
    env: { CONTACT_SOURCE_QUARANTINE: 'exampleprovider' },
  });
  assert.equal(result.decision, 'validation_failed');
  assert.ok(result.failedChecks.includes('approved_source'));
});

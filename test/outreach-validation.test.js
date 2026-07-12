'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REQUIRED_CHECKS,
  normalizeDomain,
  normalizePhone,
  normalizeCompanyName,
  createBusinessFingerprint,
  scoreQualification,
  validateProspect,
  authorizeOutreach
} = require('../lib/outreach-validation');

const policy = {
  ruleVersion: 'test-1',
  minimumIdentityConfidence: 0.8,
  minimumQualificationScore: 70,
  minimumPersonalizationScore: 75,
  minimumEvidenceCoverage: 0.9,
  maxDataAgeDays: 30,
  maxContactsPerWindow: 3,
  approvedChannels: ['email'],
  requiredBusinessFields: ['name', 'domain']
};

function validProspect() {
  return {
    id: 'prospect-1',
    campaignId: 'campaign-1',
    sequenceStepId: 'step-1',
    messageVersion: 'message-v1',
    business: { name: 'Elite Gym LLC', domain: 'elitegym.com' },
    source: { approved: true, url: 'https://elitegym.com' },
    identityStatus: 'verified',
    identityConfidence: 0.95,
    duplicateStatus: 'clear',
    campaignEligibility: 'eligible',
    suppressionStatus: 'clear',
    optOut: false,
    state: 'qualified',
    lastVerifiedAt: '2026-07-01T12:00:00.000Z',
    qualificationScore: { percentage: 88 },
    personalization: { qualityScore: 91, evidenceCoverage: 1 },
    crmSyncStatus: 'synced',
    cadenceStatus: 'allowed',
    channel: 'email',
    complianceStatus: 'passed',
    contactCountInWindow: 1,
    messageVersionStatus: 'approved'
  };
}

const runtime = {
  now: '2026-07-11T12:00:00.000Z',
  clock: () => new Date('2026-07-11T12:00:00.000Z')
};

test('normalizes identity fields consistently', () => {
  assert.equal(normalizeDomain('https://www.Example.com/team'), 'example.com');
  assert.equal(normalizePhone('+1 (305) 555-0100'), '3055550100');
  assert.equal(normalizeCompanyName('Example & Company, LLC'), 'example and');
});

test('creates the same fingerprint for equivalent businesses', () => {
  const first = createBusinessFingerprint({ name: 'Elite Gym LLC', website: 'https://www.elitegym.com', phone: '(305) 555-0100', city: 'Miami' });
  const second = createBusinessFingerprint({ name: 'Elite Gym', domain: 'elitegym.com', phone: '+1 305 555 0100', city: 'MIAMI' });
  assert.equal(first, second);
});

test('produces explainable weighted qualification score', () => {
  const score = scoreQualification({
    overallFit: 1,
    buyingPotential: 0.5,
    timingIndicators: 0.5,
    strategicValue: 1,
    dataConfidence: 1,
    personalizationReadiness: 1
  });
  assert.equal(score.max, 100);
  assert.equal(score.total, 82.5);
  assert.equal(score.categories.buyingPotential.points, 10);
});

test('approves only when every required check passes', () => {
  const validation = validateProspect(validProspect(), policy, runtime);
  assert.equal(validation.passed, true);
  assert.equal(validation.failedChecks.length, 0);
  assert.equal(validation.results.length, REQUIRED_CHECKS.length);
});

test('fails closed when any required value is absent or unknown', () => {
  const prospect = validProspect();
  delete prospect.crmSyncStatus;
  const validation = validateProspect(prospect, policy, runtime);
  assert.equal(validation.passed, false);
  assert.ok(validation.failedChecks.includes('crm_synchronized'));
});

test('global opt-out blocks outreach regardless of all other checks', () => {
  const prospect = validProspect();
  prospect.optOut = true;
  const validation = validateProspect(prospect, policy, runtime);
  assert.equal(validation.passed, false);
  assert.ok(validation.failedChecks.includes('suppression_clear'));
});

test('stale data blocks authorization', () => {
  const prospect = validProspect();
  prospect.lastVerifiedAt = '2026-01-01T00:00:00.000Z';
  assert.throws(
    () => authorizeOutreach(prospect, policy, runtime),
    error => error.code === 'OUTREACH_VALIDATION_FAILED' && error.validation.failedChecks.includes('data_freshness')
  );
});

test('successful authorization returns stable duplicate-send key', () => {
  const first = authorizeOutreach(validProspect(), policy, runtime);
  const second = authorizeOutreach(validProspect(), policy, runtime);
  assert.equal(first.authorized, true);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
});

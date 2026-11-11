'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { qualifyClinicProspect } = require('../lib/outreach/clinic-qualification');
const { validateProspect, authorizeOutreach } = require('../lib/outreach-validation');
const { templateVersion } = require('../lib/outreach/clinic-supply-email');
const { isApprovedVersion } = require('../lib/outreach/approved-message-versions');
const { resolveQueueKey } = require('../lib/job-queues');

// Simulates the owner's approval for the test only.
const approvedEnv = { OUTREACH_APPROVED_MESSAGE_VERSIONS: templateVersion(1) };
const clean = { suppression: null, priorQueueCount: 0, domainContactedElsewhere: 0 };
const NOW = new Date('2026-11-09T12:00:00Z');

const prospect = (over = {}) => ({
  prospectId: '11111111-1111-4111-8111-111111111111',
  campaignId: 'osm-business-discovery',
  stage: 'discovered',
  status: 'active',
  createdAt: '2026-11-05T10:00:00Z',
  business: { name: 'GlowVita', displayName: 'GlowVita', website: 'https://glowvitamedspa.com/', region: 'miami-fl', niche: 'med-spa', sourceRef: 'osm:node/12187997366' },
  contact: { email: 'info@glowvitamedspa.com' },
  ...over,
});

test('a high-tier clinic with its own inbox and an approved version passes all 16 checks', () => {
  const q = qualifyClinicProspect(prospect(), clean, { env: approvedEnv, now: NOW });
  assert.equal(q.qualified, true, q.blockers.join('; '));
  const v = validateProspect(q.view, q.policy, { now: NOW });
  assert.equal(v.passed, true, `failed: ${v.failedChecks.join(', ')}`);
  assert.equal(q.draft.recipient, 'info@glowvitamedspa.com');
  assert.match(q.draft.body, /in Miami/);
});

test('without the owner approving the version, nothing qualifies', () => {
  const q = qualifyClinicProspect(prospect(), clean, { env: {}, now: NOW });
  assert.equal(q.qualified, false);
  assert.match(q.blockers.join(' '), /OUTREACH_APPROVED_MESSAGE_VERSIONS/);
  assert.equal(validateProspect(q.view, q.policy, { now: NOW }).failedChecks.includes('message_version_approved'), true);
  assert.equal(isApprovedVersion(templateVersion(1), {}), false);
});

test('each status fails on missing evidence rather than defaulting to a pass', () => {
  const cases = [
    ['identity', prospect({ contact: { email: 'clinic@gmail.com' } })],
    ['identity', prospect({ contact: { email: 'info@otherdomain.com' } })],
    ['eligibility', prospect({ business: { ...prospect().business, name: 'Main Street Medical', displayName: 'Main Street Medical', website: 'https://msm.example/', niche: 'clinic' }, contact: { email: 'office@msm.example' } })],
    ['eligibility', prospect({ stage: 'disqualified' })],
    ['source', prospect({ business: { ...prospect().business, sourceRef: undefined, website: 'https://other.example/' } })],
  ];
  for (const [check, p] of cases) {
    const q = qualifyClinicProspect(p, clean, { env: approvedEnv, now: NOW });
    assert.equal(q.checks[check].passed, false, `${check} should fail`);
    assert.equal(q.qualified, false);
  }
  const facts = [
    ['suppression', { ...clean, suppression: { address: 'info@glowvitamedspa.com', reason: 'opt_out' } }],
    ['cadence', { ...clean, priorQueueCount: 1 }],
    ['duplicate', { ...clean, domainContactedElsewhere: 1 }],
  ];
  for (const [check, f] of facts) {
    const q = qualifyClinicProspect(prospect(), f, { env: approvedEnv, now: NOW });
    assert.equal(q.checks[check].passed, false, `${check} should fail`);
    assert.equal(validateProspect(q.view, q.policy, { now: NOW }).passed, false, `${check} must also fail validation`);
  }
});

test('a stale contact fails the engine\'s 30-day freshness check', () => {
  const q = qualifyClinicProspect(prospect({ createdAt: '2026-09-01T00:00:00Z' }), clean, { env: approvedEnv, now: NOW });
  assert.ok(validateProspect(q.view, q.policy, { now: NOW }).failedChecks.includes('data_freshness'));
});

test('a template edit produces an unapproved version', () => {
  assert.match(templateVersion(1), /^clinic-supply-v1-step1-[0-9a-f]{8}$/);
  assert.equal(isApprovedVersion('clinic-supply-v1-step1-deadbeef', approvedEnv), false);
});

test('two different prospects get two different authorization keys', () => {
  const a = qualifyClinicProspect(prospect(), clean, { env: approvedEnv, now: NOW });
  const b = qualifyClinicProspect(prospect({ prospectId: '22222222-2222-4222-8222-222222222222' }), clean, { env: approvedEnv, now: NOW });
  const ka = authorizeOutreach(a.view, a.policy, { now: NOW }).idempotencyKey;
  const kb = authorizeOutreach(b.view, b.policy, { now: NOW }).idempotencyKey;
  assert.notEqual(ka, kb);
  // Stored prospects carry prospectId, not id: the key must still differ.
  const k1 = authorizeOutreach({ ...a.view, id: undefined }, a.policy, { now: NOW }).idempotencyKey;
  const k2 = authorizeOutreach({ ...b.view, id: undefined }, b.policy, { now: NOW }).idempotencyKey;
  assert.notEqual(k1, k2);
});

test('addJob accepts queue keys and queue names', () => {
  assert.equal(resolveQueueKey('analytics'), 'analytics');
  assert.equal(resolveQueueKey('outreach-analytics'), 'analytics');
  assert.equal(resolveQueueKey('prospect-discovery'), 'discovery');
  assert.equal(resolveQueueKey('nope'), undefined);
});

test('the daily clinic cron refuses to enqueue unless the worker reports it can send', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'clinic-outreach-daily.js'), 'utf8');
  assert.match(src, /workerCanSend\(\)/);
  assert.match(src, /deliveryConfigured/);
  assert.doesNotMatch(src, /RESEND_API_KEY\b(?![^\n]*\))/, 'the cron must not read the Resend key itself');
});

test('OpenStreetMap ids as discovery stores them (node/123) count as a directory origin', () => {
  for (const sourceRef of ['node/12187997366', 'osm:node/12187997366', 'way/5']) {
    const q = qualifyClinicProspect(prospect({ business: { ...prospect().business, sourceRef, website: 'https://other.example/' } }), clean, { now: NOW, env: approvedEnv });
    assert.equal(q.checks.source.passed, true, sourceRef);
    assert.equal(q.checks.source.value, 'public_directory');
  }
  const bogus = qualifyClinicProspect(prospect({ business: { ...prospect().business, sourceRef: 'node/abc', website: 'https://other.example/' } }), clean, { now: NOW, env: approvedEnv });
  assert.equal(bogus.checks.source.passed, false);
});

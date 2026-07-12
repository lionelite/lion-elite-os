'use strict';

const crypto = require('crypto');

const REQUIRED_CHECKS = Object.freeze([
  'approved_source',
  'identity_verified',
  'duplicate_prevention',
  'campaign_eligibility',
  'suppression_clear',
  'required_information',
  'data_freshness',
  'qualification_threshold',
  'personalization_quality',
  'evidence_coverage',
  'crm_synchronized',
  'cadence_allowed',
  'channel_eligible',
  'campaign_compliance',
  'frequency_limit',
  'message_version_approved'
]);

const TERMINAL_BLOCKING_STATES = new Set(['suppressed', 'disqualified', 'closed']);

function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

function normalizeDomain(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/\.$/, '');
}

function normalizePhone(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function normalizeCompanyName(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(incorporated|inc|llc|ltd|corp|corporation|company|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function createBusinessFingerprint(business = {}) {
  const parts = [
    normalizeDomain(business.domain || business.website),
    normalizePhone(business.phone),
    normalizeCompanyName(business.name || business.displayName || business.legalName),
    String(business.region || business.city || '').trim().toLowerCase()
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function scoreQualification(input = {}, weights = {}) {
  const defaults = {
    overallFit: 30,
    buyingPotential: 20,
    timingIndicators: 15,
    strategicValue: 10,
    dataConfidence: 15,
    personalizationReadiness: 10
  };
  const appliedWeights = { ...defaults, ...weights };
  const categories = {};
  let total = 0;
  let max = 0;

  for (const [key, weight] of Object.entries(appliedWeights)) {
    const raw = Number(input[key] ?? 0);
    const normalized = Math.max(0, Math.min(1, raw));
    categories[key] = {
      input: normalized,
      weight,
      points: Number((normalized * weight).toFixed(2))
    };
    total += categories[key].points;
    max += weight;
  }

  return {
    total: Number(total.toFixed(2)),
    max,
    percentage: max ? Number(((total / max) * 100).toFixed(2)) : 0,
    categories
  };
}

function buildValidationContext(prospect = {}, policy = {}, runtime = {}) {
  const score = prospect.qualificationScore || { percentage: 0 };
  const message = prospect.personalization || {};
  const source = prospect.source || {};
  const now = runtime.now ? new Date(runtime.now) : new Date();
  const verifiedAt = prospect.lastVerifiedAt ? new Date(prospect.lastVerifiedAt) : null;
  const maxAgeDays = Number(policy.maxDataAgeDays ?? 30);
  const ageMs = verifiedAt ? now.getTime() - verifiedAt.getTime() : Infinity;
  const fresh = ageMs >= 0 && ageMs <= maxAgeDays * 86400000;
  const requiredFields = policy.requiredBusinessFields || ['name', 'domain'];
  const missingFields = requiredFields.filter(field => !prospect.business?.[field]);

  return {
    approved_source: Boolean(source.approved && source.url),
    identity_verified: prospect.identityStatus === 'verified' && Number(prospect.identityConfidence ?? 0) >= Number(policy.minimumIdentityConfidence ?? 0.8),
    duplicate_prevention: prospect.duplicateStatus === 'clear',
    campaign_eligibility: prospect.campaignEligibility === 'eligible' && !TERMINAL_BLOCKING_STATES.has(prospect.state),
    suppression_clear: prospect.suppressionStatus === 'clear' && prospect.optOut !== true,
    required_information: missingFields.length === 0,
    data_freshness: fresh,
    qualification_threshold: Number(score.percentage ?? 0) >= Number(policy.minimumQualificationScore ?? 70),
    personalization_quality: Number(message.qualityScore ?? 0) >= Number(policy.minimumPersonalizationScore ?? 75),
    evidence_coverage: Number(message.evidenceCoverage ?? 0) >= Number(policy.minimumEvidenceCoverage ?? 0.9),
    crm_synchronized: prospect.crmSyncStatus === 'synced',
    cadence_allowed: prospect.cadenceStatus === 'allowed',
    channel_eligible: Array.isArray(policy.approvedChannels) && policy.approvedChannels.includes(prospect.channel),
    campaign_compliance: prospect.complianceStatus === 'passed',
    frequency_limit: Number(prospect.contactCountInWindow ?? 0) < Number(policy.maxContactsPerWindow ?? 3),
    message_version_approved: prospect.messageVersionStatus === 'approved',
    diagnostics: {
      missingFields,
      verifiedAt: verifiedAt?.toISOString() || null,
      maxAgeDays,
      qualificationScore: Number(score.percentage ?? 0),
      personalizationScore: Number(message.qualityScore ?? 0),
      evidenceCoverage: Number(message.evidenceCoverage ?? 0)
    }
  };
}

function validateProspect(prospect = {}, policy = {}, runtime = {}) {
  const timestamp = nowIso(runtime.clock);
  const context = buildValidationContext(prospect, policy, runtime);
  const ruleVersion = policy.ruleVersion || '1.0.0';

  const results = REQUIRED_CHECKS.map(check => ({
    check,
    status: context[check] === true ? 'passed' : 'failed',
    passed: context[check] === true,
    reason: context[check] === true ? 'Requirement satisfied.' : 'Requirement failed or is unknown.',
    timestamp,
    ruleVersion
  }));

  const failedChecks = results.filter(result => !result.passed).map(result => result.check);
  const passed = failedChecks.length === 0;
  const validationRunId = crypto.randomUUID();

  return {
    validationRunId,
    prospectId: prospect.id || null,
    campaignId: prospect.campaignId || null,
    passed,
    decision: passed ? 'outreach_approved' : 'validation_failed',
    failedChecks,
    results,
    diagnostics: context.diagnostics,
    evaluatedAt: timestamp,
    ruleVersion
  };
}

function authorizeOutreach(prospect, policy, runtime = {}) {
  const validation = validateProspect(prospect, policy, runtime);
  if (!validation.passed) {
    const error = new Error(`Outreach blocked. Failed checks: ${validation.failedChecks.join(', ')}`);
    error.code = 'OUTREACH_VALIDATION_FAILED';
    error.validation = validation;
    throw error;
  }

  const idempotencyKey = crypto
    .createHash('sha256')
    .update([prospect.id, prospect.campaignId, prospect.sequenceStepId, prospect.messageVersion].join('|'))
    .digest('hex');

  return {
    authorized: true,
    validation,
    idempotencyKey,
    authorizedAt: nowIso(runtime.clock)
  };
}

module.exports = {
  REQUIRED_CHECKS,
  normalizeDomain,
  normalizePhone,
  normalizeCompanyName,
  createBusinessFingerprint,
  scoreQualification,
  buildValidationContext,
  validateProspect,
  authorizeOutreach
};

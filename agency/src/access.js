'use strict';

// Step 3 support: contractors get exactly the access their assigned ticket
// requires, and nothing else — including nothing that would let them step
// around us to the client.
//
// Two separate risks are handled here and they are not the same:
//   1. SECURITY — a contractor with the client's production database or API keys
//      is an incident waiting to happen, and it is our company on the contract.
//   2. CHANNEL CONTROL — a contractor with the client's email address, billing
//      portal or Slack can quote the next phase directly. That is not a security
//      breach, it is the loss of the business.
//
// NEVER_GRANT is absolute. It is not a default that a ticket can override, in
// the same spirit as the repo-level hard limits: a request for one of those
// resources returns DENY with a reason, whatever the ticket says it needs.

// Graduated tiers. A ticket declares the lowest tier that can complete it.
const TIERS = Object.freeze(['docs-only', 'sandbox', 'staging', 'integration-sandbox']);

const TIER_GRANTS = Object.freeze({
  // Spec review, estimates, technical write-ups.
  'docs-only': Object.freeze(['ticket-spec', 'public-docs']),
  // Normal build work: our repo, their own branch, synthetic fixtures.
  sandbox: Object.freeze(['ticket-spec', 'public-docs', 'repo-branch', 'synthetic-dataset', 'ci-logs-own-branch']),
  // Work that must be exercised against a running system.
  staging: Object.freeze(['ticket-spec', 'public-docs', 'repo-branch', 'synthetic-dataset', 'ci-logs-own-branch', 'staging-env', 'staging-credentials']),
  // Third-party integration work needing a sandbox tenant of the vendor.
  'integration-sandbox': Object.freeze(['ticket-spec', 'public-docs', 'repo-branch', 'synthetic-dataset', 'ci-logs-own-branch', 'staging-env', 'staging-credentials', 'vendor-sandbox-tenant']),
});

// Never granted to a contractor, at any tier, for any reason.
const NEVER_GRANT = Object.freeze({
  'client-production-database': 'Production client data. Contractors work against synthetic fixtures; we run the migration.',
  'client-production-credentials': 'Live API keys and secrets stay in our vault and on our deploy targets only.',
  'client-payment-account': 'Billing and payment rails are the client\'s relationship with our company.',
  'client-ad-account': 'Ad accounts carry spend authority.',
  'client-dns': 'Domain and DNS control is an account-takeover vector and stays with us.',
  'client-direct-contact': 'All client communication is ours. A contractor in the client\'s inbox can quote the next phase.',
  'client-billing-portal': 'Commercial channel — contractors never see or touch client invoicing.',
  'our-secrets-vault': 'Our own credential store. Nobody outside the company.',
  'production-deploy': 'Only our deploy process ships to production. Merge and deploy are our authority.',
  'client-crm-production': 'Live customer records. Redacted exports only, and only when a ticket genuinely requires them.',
  'repo-admin': 'Repository settings, branch protection and collaborator management stay with us.',
  'repo-main-branch-write': 'Contractors open pull requests. Merging is our quality gate.',
});

// Compliance flags from the client's vertical restrict tiers further.
const COMPLIANCE_RESTRICTIONS = Object.freeze({
  PHI: Object.freeze({
    maxTier: 'sandbox',
    reason: 'PHI in scope: contractors may not reach any environment where protected health information exists, including staging. Synthetic fixtures only.',
  }),
  HIPAA_BAA_REQUIRED: Object.freeze({
    requiresAgreement: 'baa',
    reason: 'A Business Associate Agreement must be executed before any contractor touches the engagement.',
  }),
  PII_FINANCIAL: Object.freeze({
    maxTier: 'sandbox',
    reason: 'Financial PII in scope: staging carries real customer records. Synthetic fixtures only.',
  }),
  REG_RECORDKEEPING: Object.freeze({
    requiresAgreement: 'confidentiality',
    reason: 'Regulated recordkeeping: all work product must stay inside our audit trail.',
  }),
});

function tierRank(tier) {
  return TIERS.indexOf(tier);
}

function grantsFor(tier) {
  return TIER_GRANTS[tier] ? [...TIER_GRANTS[tier]] : null;
}

/**
 * Build the access plan for one ticket, given the engagement's compliance flags.
 *
 * Returns the effective tier (possibly downgraded by compliance), the concrete
 * grant list, the denials that apply regardless, and any agreements that must be
 * signed first.
 */
function accessPlanForTicket(ticket = {}, complianceFlags = []) {
  const requested = ticket.accessTier || 'sandbox';
  if (!TIERS.includes(requested)) {
    throw new Error(`Unknown access tier "${requested}". Expected one of ${TIERS.join(', ')}.`);
  }

  let effectiveTier = requested;
  const restrictions = [];
  const requiredAgreements = new Set(['nda', 'ip-assignment', 'non-solicit']);

  for (const flag of complianceFlags || []) {
    const rule = COMPLIANCE_RESTRICTIONS[flag];
    if (!rule) continue;
    if (rule.maxTier && tierRank(effectiveTier) > tierRank(rule.maxTier)) {
      effectiveTier = rule.maxTier;
      restrictions.push(rule.reason);
    } else if (rule.maxTier) {
      // Tier already within the cap, but the constraint still belongs on the record.
      restrictions.push(rule.reason);
    }
    if (rule.requiresAgreement) {
      requiredAgreements.add(rule.requiresAgreement);
      restrictions.push(rule.reason);
    }
  }

  return {
    ticketId: ticket.id || null,
    requestedTier: requested,
    effectiveTier,
    downgraded: effectiveTier !== requested,
    grants: grantsFor(effectiveTier),
    deniedAlways: Object.keys(NEVER_GRANT),
    restrictions,
    requiredAgreements: [...requiredAgreements],
  };
}

/**
 * Adjudicate a contractor's ad-hoc access request — the "can you just give me
 * the production API key so I can test" message.
 *
 * Returns { decision: 'DENY' | 'ALLOW', reason, alternative }. DENY is the
 * default for anything not in the ticket's grant list, because an unrecognised
 * resource is an unassessed resource.
 */
function reviewAccessRequest({ resource, ticket = {}, complianceFlags = [] } = {}) {
  const key = String(resource || '').trim();
  if (!key) return { decision: 'DENY', resource: key, reason: 'No resource named in the request.', alternative: null };

  if (NEVER_GRANT[key]) {
    return {
      decision: 'DENY',
      resource: key,
      reason: NEVER_GRANT[key],
      alternative: 'We run this step in-house. Send the exact command or migration you need executed and we will run it and return the output.',
    };
  }

  const plan = accessPlanForTicket(ticket, complianceFlags);
  if (plan.grants.includes(key)) {
    return { decision: 'ALLOW', resource: key, reason: `Within the ${plan.effectiveTier} tier granted for ${plan.ticketId || 'this ticket'}.`, alternative: null };
  }

  return {
    decision: 'DENY',
    resource: key,
    reason: `Not in the ${plan.effectiveTier} tier granted for ${plan.ticketId || 'this ticket'}. Access is per-ticket, not per-person.`,
    alternative: 'If the ticket genuinely cannot be completed without it, reply on the ticket with why and we will either scope a higher tier or run that step ourselves.',
  };
}

/**
 * Offboarding checklist. Revocation is the step everyone forgets, and an
 * ex-contractor with a live staging credential is the same exposure as a current
 * one with no ticket.
 */
function revocationChecklist(plan) {
  const items = (plan && plan.grants ? plan.grants : [])
    .filter((g) => g !== 'ticket-spec' && g !== 'public-docs')
    .map((g) => `Revoke: ${g}`);
  return [
    ...items,
    'Remove from repository collaborators',
    'Rotate any staging credential the contractor held',
    'Confirm all work product is merged or closed — nothing left only on their machine',
    'Confirm IP assignment covers every merged commit',
  ];
}

module.exports = {
  TIERS,
  TIER_GRANTS,
  NEVER_GRANT,
  COMPLIANCE_RESTRICTIONS,
  grantsFor,
  accessPlanForTicket,
  reviewAccessRequest,
  revocationChecklist,
};

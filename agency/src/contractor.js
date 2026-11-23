'use strict';

// Step 5: our company controls the relationship.
//
// Two gates live here.
//
// ASSIGNMENT GATE — a contractor cannot be assigned a ticket until the paperwork
// that makes their output ours is executed. The order matters: code written
// before an IP assignment is signed is code we may not own, and discovering that
// during a client's due diligence is a catastrophe. So the gate is fail-closed:
// unsigned or expired paperwork returns eligible: false, with the missing items
// named.
//
// CHANNEL GATE — contractors do not quote, invoice, or talk commercially to the
// client. This is not about distrust; it is that the client bought a relationship
// with our company, and a contractor negotiating scope directly destroys both the
// margin and the accountability the client is paying for.
//
// NOT LEGAL ADVICE: the agreement identifiers here track what has been signed.
// The actual agreement text must be drafted or reviewed by an attorney in the
// relevant jurisdiction — see agency/templates/contractor-agreement-terms.md.

// Agreements every contractor signs before any assignment.
const BASE_AGREEMENTS = Object.freeze(['nda', 'ip-assignment', 'non-solicit', 'independent-contractor']);

// Agreement identifiers that may additionally be required by a client's
// compliance profile (see access.js COMPLIANCE_RESTRICTIONS).
const CONDITIONAL_AGREEMENTS = Object.freeze(['baa', 'confidentiality']);

const AGREEMENT_PURPOSE = Object.freeze({
  nda: 'Confidentiality over client data, our architecture, and commercial terms.',
  'ip-assignment': 'Present assignment of all work product to our company — the reason we can sell the code to the client.',
  'non-solicit': 'No soliciting our clients or our other contractors for the agreed period.',
  'independent-contractor': 'Fixed-price engagement terms, no employment relationship, no authority to bind our company.',
  baa: 'Business Associate Agreement — required before any engagement where PHI is in scope.',
  confidentiality: 'Enhanced confidentiality and record-retention terms for regulated engagements.',
});

// Commercial acts reserved to our company. A contractor doing any of these is a
// breach of the channel, whether or not they meant harm.
const RESERVED_TO_AGENCY = Object.freeze([
  'quoting price or scope to the client',
  'invoicing the client',
  'negotiating timeline or deliverables with the client',
  'proposing additional work to the client',
  'contacting the client outside a channel we host and observe',
  'representing themselves as our employee or as the client\'s vendor',
  'subcontracting their ticket without our written approval',
]);

// Phrases that indicate a contractor message is drifting into reserved
// commercial territory. Used by reviewContractorMessage() as a pre-send check on
// anything a contractor wants relayed.
const COMMERCIAL_SIGNALS = Object.freeze([
  { pattern: /\b(my|our)\s+(rate|rates|hourly|price|pricing|fee|fees)\b/i, reason: 'States the contractor\'s own commercial terms.' },
  { pattern: /\b(invoice|invoicing|paypal|venmo|wire|zelle|pay\s+me|payment\s+details)\b/i, reason: 'Attempts a direct payment path.' },
  { pattern: /\b(i|we)\s+(can|could)\s+(also\s+)?(build|do|add|deliver)\b.*\b(for|at)\s*\$?\d/i, reason: 'Quotes additional work at a price.' },
  { pattern: /\b(work\s+(with|for)\s+me\s+directly|cut\s+out|go\s+direct|hire\s+me)\b/i, reason: 'Solicits a direct relationship with the client.' },
  { pattern: /\b(next\s+phase|phase\s+2|follow[- ]?on)\b.*\b(quote|proposal|estimate|cost)\b/i, reason: 'Proposes and prices follow-on work.' },
  { pattern: /\b(my\s+)?(linkedin|upwork|fiverr|calendly|portfolio)\b/i, reason: 'Routes the client to the contractor\'s own channel.' },
  { pattern: /\b(timeline|deadline|delivery\s+date)\s+(can|could|will)\s+(slip|change|move)\b/i, reason: 'Renegotiates timeline directly with the client.' },
]);

function isTruthyDate(value) {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

/**
 * Can this contractor be assigned this ticket?
 *
 * `contractor.agreements` is a map of agreement id → { signedAt, expiresAt }.
 * `requiredAgreements` comes from the ticket's access plan, which already folds
 * in the engagement's compliance flags.
 */
function assignmentEligibility(contractor = {}, requiredAgreements = BASE_AGREEMENTS, { asOf = new Date() } = {}) {
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  const signed = contractor.agreements && typeof contractor.agreements === 'object' ? contractor.agreements : {};
  const required = new Set([...BASE_AGREEMENTS, ...(requiredAgreements || [])]);

  const missing = [];
  const expired = [];
  for (const id of required) {
    const record = signed[id];
    if (!record || !isTruthyDate(record.signedAt)) {
      missing.push({ id, purpose: AGREEMENT_PURPOSE[id] || 'Required agreement.' });
      continue;
    }
    if (record.expiresAt && isTruthyDate(record.expiresAt) && new Date(record.expiresAt) < now) {
      expired.push({ id, expiresAt: record.expiresAt });
    }
  }

  const blockers = [];
  if (missing.length) blockers.push(`Unsigned: ${missing.map((m) => m.id).join(', ')}.`);
  if (expired.length) blockers.push(`Expired: ${expired.map((e) => e.id).join(', ')}.`);
  if (contractor.suspended === true) blockers.push('Contractor is suspended.');
  if (contractor.paymentDetailsOnFile === false) blockers.push('No payment details on file — a fixed-price milestone cannot be settled.');

  return {
    eligible: blockers.length === 0,
    contractorId: contractor.id || null,
    required: [...required],
    missing,
    expired,
    blockers,
  };
}

/**
 * Assign a ticket. Throws rather than returning a bad assignment, because an
 * assignment is an action with consequences (repo access, a payment obligation),
 * not a query.
 */
function assignTicket(ticket, contractor, { asOf = new Date() } = {}) {
  if (!ticket || !ticket.id) throw new TypeError('A ticket with an id is required.');
  if (!ticket.accessPlan) throw new Error(`Ticket ${ticket.id} has no access plan — build it through buildDeliveryPlan().`);
  const eligibility = assignmentEligibility(contractor, ticket.accessPlan.requiredAgreements, { asOf });
  if (!eligibility.eligible) {
    throw new Error(`Cannot assign ${ticket.id} to ${contractor && contractor.id ? contractor.id : 'contractor'}: ${eligibility.blockers.join(' ')}`);
  }
  return {
    ticketId: ticket.id,
    contractorId: contractor.id,
    fixedPrice: ticket.fixedPrice,
    billing: 'fixed-price-on-acceptance',
    accessTier: ticket.accessPlan.effectiveTier,
    grants: [...ticket.accessPlan.grants],
    denied: [...ticket.accessPlan.deniedAlways],
    assignedAt: (asOf instanceof Date ? asOf : new Date(asOf)).toISOString(),
    channelRules: [...RESERVED_TO_AGENCY],
  };
}

/**
 * Pre-send review of anything a contractor wants passed to the client.
 *
 * Returns { relay: boolean, findings }. `relay: false` means we answer the
 * client ourselves. This is not censorship of technical content — technical
 * answers relay fine; it catches commercial content only.
 */
function reviewContractorMessage(message, { clientFacing = true } = {}) {
  const text = String(message || '');
  const findings = COMMERCIAL_SIGNALS.filter((s) => s.pattern.test(text)).map((s) => ({ reason: s.reason }));
  return {
    relay: !clientFacing || findings.length === 0,
    clientFacing,
    findings,
    action: findings.length
      ? 'Do not relay. Answer the client directly ourselves, then address the channel rule with the contractor.'
      : 'Safe to relay.',
  };
}

/**
 * Onboarding checklist for a new contractor — the ordered sequence that ends in
 * "eligible for assignment".
 */
function onboardingChecklist() {
  return [
    ...BASE_AGREEMENTS.map((id) => `Execute ${id}: ${AGREEMENT_PURPOSE[id]}`),
    'Collect tax/payment details for fixed-price settlement',
    'Confirm the contractor understands they are paid per accepted milestone, not per hour',
    'Walk through the reserved-commercial-acts list explicitly',
    'Create their repo access at the ticket\'s tier only — never organisation-wide',
    'Confirm no production credential, client contact or billing access was shared',
  ];
}

module.exports = {
  BASE_AGREEMENTS,
  CONDITIONAL_AGREEMENTS,
  AGREEMENT_PURPOSE,
  RESERVED_TO_AGENCY,
  COMMERCIAL_SIGNALS,
  assignmentEligibility,
  assignTicket,
  reviewContractorMessage,
  onboardingChecklist,
};

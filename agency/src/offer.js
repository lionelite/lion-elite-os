'use strict';

// The productized offer — ONE thing we sell, deliberately.
//
// The failure mode this file exists to prevent: an agency that says yes to
// "every type of software" has no repeatable scope, no reusable architecture,
// no predictable developer cost, and therefore no predictable margin. So the
// offer is a fixed capability set, and anything outside it is either an
// explicit add-on with its own price or a decline — never a silent yes in a
// sales call.
//
// What we sell (the sentence used verbatim in outbound and on the site):
//
//   "We build AI systems that recover missed leads, automate follow-up,
//    qualify prospects, schedule appointments, and show management exactly
//    how much revenue the system produces."
//
// Note the order: the last capability (reporting) is what makes the first four
// re-purchasable. A client who cannot see the revenue the system produced does
// not renew a retainer.

const OFFER_ID = 'missed-revenue-recovery';

const OFFER_STATEMENT =
  'We build AI systems that recover missed leads, automate follow-up, qualify prospects, ' +
  'schedule appointments, and show management exactly how much revenue the system produces.';

// The five in-scope capabilities. `id` is the key every milestone, ticket and
// acceptance test traces back to, so a delivered system can be audited against
// what was sold.
const CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'lead-capture',
    name: 'Missed-lead recovery',
    outcome: 'Every inbound lead — form, call, chat, email, marketplace — is captured and never dropped.',
    businessCase: 'revenue-gained',
    verification: 'A test lead submitted through every agreed channel appears in the system within the agreed interval, with none lost.',
    required: true, // the spine of the offer; cannot be dropped from a build
  }),
  Object.freeze({
    id: 'follow-up',
    name: 'Automated multi-touch follow-up',
    outcome: 'Each lead gets a timed follow-up sequence until it replies, books, or opts out.',
    businessCase: 'revenue-gained',
    verification: 'A test lead receives the full approved sequence on schedule, and replying, booking or opting out stops it immediately.',
    required: true,
  }),
  Object.freeze({
    id: 'qualification',
    name: 'AI qualification and routing',
    outcome: 'Leads are scored and routed so the sales team spends its hours on the ones that can buy.',
    businessCase: 'hours-saved',
    verification: 'A set of sample leads is scored and routed to the destinations agreed in the scope document, with each decision explainable.',
    required: true,
  }),
  Object.freeze({
    id: 'scheduling',
    name: 'Appointment scheduling',
    outcome: 'Qualified leads land on the right calendar without a human coordinating it.',
    businessCase: 'hours-saved',
    verification: 'A qualified test lead books a real slot on the correct calendar, and reschedule and cancellation both update it.',
    required: false,
  }),
  Object.freeze({
    id: 'reporting',
    name: 'Revenue attribution reporting',
    outcome: 'Management sees recovered leads, booked appointments, and closed revenue attributable to the system.',
    businessCase: 'revenue-gained',
    verification: 'The dashboard reports captured, recovered, qualified, booked and closed figures that reconcile with your own records.',
    required: true, // this is what renews the retainer — never cut it to hit a price
  }),
]);

// Priced add-ons. In scope for us to deliver, but NOT inside the base price —
// quoting these as "sure, we can include that" is how a 60% margin becomes 20%.
const ADD_ONS = Object.freeze([
  Object.freeze({ id: 'crm-migration', name: 'CRM data migration', note: 'Priced per record volume after a data audit.' }),
  Object.freeze({ id: 'extra-integration', name: 'Additional system integration beyond the agreed list', note: 'Per-integration fixed price.' }),
  Object.freeze({ id: 'voice-agent', name: 'Inbound voice answering agent', note: 'Separate build; telephony cost is the client\'s.' }),
  Object.freeze({ id: 'multi-location', name: 'Additional location or business unit rollout', note: 'Per-unit fixed price after the first is live.' }),
]);

// Hard out-of-scope. These are declines, not negotiations — each one destroys
// the productized model in a different way (unbounded scope, unbounded
// liability, or a delivery skill set our contractor bench does not have).
const OUT_OF_SCOPE = Object.freeze([
  Object.freeze({ pattern: /\b(mobile|ios|android)\s*app\b/i, reason: 'Consumer mobile app development — different bench, different QA surface, unbounded scope.' }),
  Object.freeze({ pattern: /\b(custom\s+)?erp\b/i, reason: 'ERP build/replacement — multi-year scope with no fixed-price shape.' }),
  Object.freeze({ pattern: /\bblockchain|web3|token\b/i, reason: 'Outside the offer and outside our competence.' }),
  Object.freeze({ pattern: /\b(staff\s*aug(mentation)?|dedicated\s+developer|hourly\s+dev)/i, reason: 'Staff augmentation — sells hours instead of outcomes and inverts the margin model.' }),
  Object.freeze({ pattern: /\bhipaa[- ]?(certified|compliant)\s+(ehr|emr)\b/i, reason: 'Clinical record systems — regulated build we do not underwrite.' }),
  Object.freeze({ pattern: /\b(take\s*over|rescue|fix)\s+(our\s+)?(legacy|existing)\s+(codebase|system)\b/i, reason: 'Inherited-codebase rescue — cost is undiscoverable before a paid audit.' }),
  Object.freeze({ pattern: /\bguarantee(d)?\s+(results|revenue|roi|leads)\b/i, reason: 'Guaranteed outcomes — we sell a system and a forecast, never a revenue guarantee.' }),
]);

// Target verticals: businesses where ONE recovered customer is worth thousands,
// which is the only condition under which a $20k system is an easy yes.
// `minCustomerValue` is the floor we expect in that vertical and is used by
// qualification.js as a sanity check on what a prospect tells us.
// `complianceFlags` propagate into the contractor access plan — a medical
// practice's build cannot be staffed the way a contractor's can.
const TARGET_VERTICALS = Object.freeze([
  Object.freeze({ id: 'oil-gas-services', name: 'Oil & gas services', minCustomerValue: 15000, complianceFlags: Object.freeze([]) }),
  Object.freeze({ id: 'specialty-contractor', name: 'Specialty contractors (roofing, HVAC, electrical, restoration)', minCustomerValue: 8000, complianceFlags: Object.freeze([]) }),
  Object.freeze({ id: 'private-medical', name: 'Private medical / dental / aesthetics practices', minCustomerValue: 3000, complianceFlags: Object.freeze(['PHI', 'HIPAA_BAA_REQUIRED']) }),
  Object.freeze({ id: 'logistics', name: 'Logistics & freight', minCustomerValue: 10000, complianceFlags: Object.freeze([]) }),
  Object.freeze({ id: 'commercial-real-estate', name: 'Commercial real estate', minCustomerValue: 20000, complianceFlags: Object.freeze([]) }),
  Object.freeze({ id: 'financial-services', name: 'Financial & insurance firms', minCustomerValue: 5000, complianceFlags: Object.freeze(['PII_FINANCIAL', 'REG_RECORDKEEPING']) }),
]);

function capability(id) {
  return CAPABILITIES.find((c) => c.id === id) || null;
}

function vertical(id) {
  return TARGET_VERTICALS.find((v) => v.id === id) || null;
}

/**
 * Resolve the capability set for one build.
 *
 * Unknown ids are rejected rather than ignored — a proposal that silently drops
 * a capability the client heard in the sales call is a dispute waiting to
 * happen. Required capabilities are always included even if the caller omits
 * them, because a build without capture, follow-up, qualification and reporting
 * is not this offer.
 */
function resolveCapabilities(requested) {
  const ids = Array.isArray(requested) && requested.length ? requested : CAPABILITIES.map((c) => c.id);
  const unknown = ids.filter((id) => !capability(id));
  if (unknown.length) throw new Error(`Unknown capability id(s): ${unknown.join(', ')}`);
  const required = CAPABILITIES.filter((c) => c.required).map((c) => c.id);
  const selected = new Set([...required, ...ids]);
  // Return in canonical delivery order, not the order the client said them in.
  return CAPABILITIES.filter((c) => selected.has(c.id));
}

/**
 * Scope guard for a discovery call. Feed it the prospect's own words.
 *
 * Returns { inScope, declines, addOns } — `declines` is what you say no to on
 * the call (with the reason, out loud), `addOns` is what you price separately.
 * A non-empty `declines` does NOT necessarily kill the deal; it kills that
 * request. Keeping the productized scope intact is the whole margin thesis.
 */
function scopeGuard(request) {
  const text = String(request || '');
  const declines = OUT_OF_SCOPE.filter((rule) => rule.pattern.test(text)).map((rule) => ({ reason: rule.reason }));
  const addOns = ADD_ONS.filter((a) => {
    const needle = a.name.split(' ')[0].toLowerCase();
    return text.toLowerCase().includes(needle);
  }).map((a) => ({ id: a.id, name: a.name, note: a.note }));
  return { inScope: declines.length === 0, declines, addOns };
}

module.exports = {
  OFFER_ID,
  OFFER_STATEMENT,
  CAPABILITIES,
  ADD_ONS,
  OUT_OF_SCOPE,
  TARGET_VERTICALS,
  capability,
  vertical,
  resolveCapabilities,
  scopeGuard,
};

'use strict';

// SOP ledger — the discipline that keeps this from being a copy machine.
// A pattern mined from OTHER people's winners is only ever a CANDIDATE. It
// becomes a permanent Lion Elite SOP only after WE launch a test and OUR OWN
// measured result validates it. This is the "adapt, launch, let our results
// decide" loop, encoded so it can't be skipped.
//
// Lifecycle:
//   candidate ──startTest──▶ testing ──(recordResult ≥1 positive)──▶ confirm ──▶ confirmed
//        │                      │                                                    │
//        └────────retire────────┴──────────────────retire───────────────────────────┴──▶ retired
//
// Confirm is BLOCKED unless a positive result measured by us is on record.

const STATUSES = Object.freeze(['candidate', 'testing', 'confirmed', 'retired']);

function newLedger() {
  return { patterns: {} };
}

function get(ledger, patternId) {
  const p = ledger.patterns[patternId];
  if (!p) throw new Error(`Unknown pattern: ${patternId}`);
  return p;
}

// Register a candidate pattern (typically from proposeCandidates()).
function addCandidate(ledger, { patternId, statement, evidence = [] }) {
  if (!patternId) throw new Error('patternId is required');
  if (ledger.patterns[patternId]) return ledger; // idempotent
  ledger.patterns[patternId] = {
    patternId,
    statement: statement || patternId,
    status: 'candidate',
    borrowedEvidence: evidence, // other brands' winners — NOT proof for us
    ourResults: [],
    history: [{ at: new Date().toISOString(), to: 'candidate' }]
  };
  return ledger;
}

function transition(pattern, to, note) {
  pattern.status = to;
  pattern.history.push({ at: new Date().toISOString(), to, note: note || null });
}

// We commit to actually testing this pattern in a Lion Elite campaign.
function startTest(ledger, patternId, { campaign, hypothesis } = {}) {
  const p = get(ledger, patternId);
  if (p.status !== 'candidate') throw new Error(`Can only test a candidate; ${patternId} is ${p.status}`);
  p.testPlan = { campaign: campaign || null, hypothesis: hypothesis || null };
  transition(p, 'testing', campaign ? `testing in ${campaign}` : 'testing');
  return ledger;
}

// Record a result WE measured. direction: 'increase'|'decrease'; `good`
// says whether that direction was the desired outcome for this metric.
function recordResult(ledger, patternId, { metric, value, direction, good, campaign, note } = {}) {
  const p = get(ledger, patternId);
  if (p.status !== 'testing' && p.status !== 'confirmed') {
    throw new Error(`Record results only while testing/confirmed; ${patternId} is ${p.status}`);
  }
  if (!metric || typeof value !== 'number') throw new Error('metric name and numeric value are required');
  p.ourResults.push({
    metric, value, direction: direction || null,
    good: good !== false, // default: treat a recorded result as a win unless told otherwise
    campaign: campaign || null, note: note || null,
    at: new Date().toISOString()
  });
  return ledger;
}

function hasPositiveOwnResult(pattern) {
  return pattern.ourResults.some((r) => r.good === true);
}

// Promote to a permanent SOP — only if OUR OWN positive result exists.
function confirm(ledger, patternId, note) {
  const p = get(ledger, patternId);
  if (p.status !== 'testing') throw new Error(`Confirm only from testing; ${patternId} is ${p.status}`);
  if (!hasPositiveOwnResult(p)) {
    throw new Error(`Cannot confirm ${patternId}: no positive Lion Elite result on record. Borrowed case-study numbers are not enough.`);
  }
  transition(p, 'confirmed', note);
  return ledger;
}

// Kill a pattern that didn't earn its place (any status).
function retire(ledger, patternId, reason) {
  const p = get(ledger, patternId);
  transition(p, 'retired', reason || 'retired');
  return ledger;
}

function byStatus(ledger, status) {
  return Object.values(ledger.patterns).filter((p) => p.status === status);
}

// The permanent playbook: everything WE proved.
function confirmedSOPs(ledger) {
  return byStatus(ledger, 'confirmed');
}

module.exports = {
  STATUSES,
  newLedger,
  addCandidate,
  startTest,
  recordResult,
  confirm,
  retire,
  byStatus,
  confirmedSOPs,
  hasPositiveOwnResult
};

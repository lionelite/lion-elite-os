'use strict';

// Engagement ledger — the state that survives the process exiting.
//
// planEngagement() answers "should we do this deal and at what price". It
// answers that fresh every time and remembers nothing. This module is the other
// half: what actually happened. Which proposal went out, whether the deposit
// landed, which milestones passed QC, what we really paid contractors, and
// therefore what the margin actually was rather than what we projected.
//
// Why that matters beyond bookkeeping: the delivery cost estimates in
// engagement.js are planning numbers. Without recorded actuals they never
// improve, and an agency whose estimates never improve is one bad quote away
// from a zero-margin project. The `estimate-variance` QC item exists to feed
// this file.
//
// Pure by design: every function takes a ledger and returns it, with no file or
// network access. Persistence lives in ledger-store.js. Transitions are
// fail-closed — an illegal move throws rather than being recorded, because a
// ledger you cannot trust is worse than no ledger.

const STATES = Object.freeze([
  'qualified',    // the engine says proceed; nothing sent yet
  'proposed',     // proposal issued, awaiting signature
  'won',          // signed and deposit collected in full
  'in_delivery',  // tickets assigned, work under way
  'delivered',    // every milestone accepted and the balance collected
  'closed',       // engagement complete; retainer (if any) runs separately
  'lost',         // terminal
  'disqualified', // terminal
]);

// Legal transitions. Anything absent is illegal.
const TRANSITIONS = Object.freeze({
  qualified: Object.freeze(['proposed', 'lost', 'disqualified']),
  proposed: Object.freeze(['won', 'lost']),
  won: Object.freeze(['in_delivery', 'lost']),
  in_delivery: Object.freeze(['delivered']),
  delivered: Object.freeze(['closed']),
  closed: Object.freeze([]),
  lost: Object.freeze([]),
  disqualified: Object.freeze([]),
});

const TERMINAL = Object.freeze(['closed', 'lost', 'disqualified']);

// `closed` is terminal for the BUILD, not for the relationship: the retainer is
// billed monthly for as long as it runs, and support costs keep accruing. Dead
// states are the ones where nothing further can legitimately happen.
const DEAD = Object.freeze(['lost', 'disqualified']);

// Receipt kinds that remain legitimate on a closed engagement. Anything to do
// with the build is settled by then — a late "deposit" on a closed build is a
// bookkeeping error worth catching.
const POST_CLOSE_RECEIPT_KINDS = Object.freeze(['retainer']);

// Probability weights for pipeline forecasting. Deliberately conservative: a
// proposal out the door is not half a sale, and treating it as one is how an
// agency plans spending against revenue that never arrives.
const PIPELINE_WEIGHTS = Object.freeze({
  qualified: 0.1,
  proposed: 0.3,
  won: 1,
  in_delivery: 1,
  delivered: 1,
  closed: 1,
  lost: 0,
  disqualified: 0,
});

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
}

function nowIso(at) {
  if (!at) return new Date().toISOString();
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid timestamp: ${at}`);
  return d.toISOString();
}

/**
 * Open a ledger from a planned engagement.
 *
 * A disqualified or blocked engagement opens in its own terminal/initial state
 * rather than being refused: we want the record that we looked at it and said
 * no, so the same prospect is not re-worked from scratch in six months.
 */
function openLedger(engagement, { at } = {}) {
  if (!engagement || !engagement.clientRef) throw new TypeError('A planned engagement is required.');

  const disqualified = engagement.stage === 'disqualified';
  const ledger = {
    clientRef: engagement.clientRef,
    clientName: engagement.clientName,
    offerId: engagement.offerId,
    state: disqualified ? 'disqualified' : 'qualified',
    openedAt: nowIso(at),
    // The quote as planned. Frozen at open so later actuals are comparable
    // against what we actually promised, not against a re-run of the engine
    // with different inputs.
    planned: disqualified ? null : {
      projectPrice: engagement.economics.projectPrice,
      depositAmount: engagement.economics.depositAmount,
      balanceAmount: engagement.economics.balanceAmount,
      developerCost: engagement.economics.developerCost,
      opsCost: engagement.economics.opsCost,
      grossProfit: engagement.economics.grossProfit,
      grossMarginPct: engagement.economics.grossMarginPct,
      monthlyRetainer: engagement.economics.monthlyRetainer,
      quarterlyOptimization: (engagement.retainer && engagement.retainer.quarterlyOptimization) || 0,
      milestones: engagement.deliveryPlan.milestones.map((m) => ({
        id: m.id,
        name: m.name,
        developerPayout: m.developerPayout,
        triggersClientBalance: m.triggersClientBalance === true,
      })),
    },
    receipts: [],    // money in from the client
    payments: [],    // money out to contractors
    // Ticket assignments. Kept here rather than on a contractor record so the
    // ledgers stay the single source of truth for who is holding what: bench
    // capacity and a contractor's track record are both derived from real work
    // rather than a parallel list that drifts out of step with it.
    assignments: [],
    opsSpend: [],   // our own software/operating spend
    milestones: disqualified ? [] : engagement.deliveryPlan.milestones.map((m) => ({
      id: m.id,
      accepted: false,
      acceptedAt: null,
      reviewedBy: null,
      paid: false,
    })),
    history: [{ at: nowIso(at), to: disqualified ? 'disqualified' : 'qualified', note: engagement.recommendation || null }],
  };
  return ledger;
}

// Blocks anything on a dead engagement, and anything build-related on a closed
// one. Use `allowClosed` for activity that legitimately outlives the build.
/**
 * Bring a ledger loaded from disk up to the current shape.
 *
 * Ledgers outlive the code that wrote them — a ledger opened before
 * `assignments` existed is still a live engagement, and must not throw the first
 * time something touches a field added later. Every schema addition gets a
 * default here rather than a defensive `|| []` scattered across call sites,
 * because the scattered version only covers the paths someone remembered.
 */
function normalize(ledger) {
  if (!ledger || typeof ledger !== 'object') return ledger;
  if (!Array.isArray(ledger.receipts)) ledger.receipts = [];
  if (!Array.isArray(ledger.payments)) ledger.payments = [];
  if (!Array.isArray(ledger.opsSpend)) ledger.opsSpend = [];
  if (!Array.isArray(ledger.assignments)) ledger.assignments = [];
  if (!Array.isArray(ledger.milestones)) ledger.milestones = [];
  if (!Array.isArray(ledger.history)) ledger.history = [];
  return ledger;
}

function assertActive(ledger, { allowClosed = false } = {}) {
  if (DEAD.includes(ledger.state)) {
    throw new Error(`Engagement ${ledger.clientRef} is ${ledger.state}. Open a new engagement instead of reviving this one.`);
  }
  if (ledger.state === 'closed' && !allowClosed) {
    throw new Error(`Engagement ${ledger.clientRef} is closed — the build is settled. Only retainer activity is recorded after close.`);
  }
}

/**
 * Move the engagement to a new state. Throws on an illegal transition, and on a
 * legal transition whose precondition is not met (see the guards below).
 */
function transition(ledger, to, { note, at } = {}) {
  if (!STATES.includes(to)) throw new Error(`Unknown state "${to}".`);
  const allowed = TRANSITIONS[ledger.state] || [];
  if (!allowed.includes(to)) {
    throw new Error(`Illegal transition ${ledger.state} → ${to} for ${ledger.clientRef}. Allowed: ${allowed.length ? allowed.join(', ') : 'none (terminal)'}.`);
  }

  // Preconditions. These are the rules that stop the ledger recording a
  // fiction — work started before the deposit cleared, delivery declared with
  // milestones still open.
  if (to === 'won') {
    const received = totalReceipts(ledger);
    if (received < ledger.planned.depositAmount) {
      throw new Error(`Cannot mark ${ledger.clientRef} won: $${round(received)} received against a $${ledger.planned.depositAmount} deposit. Record the full deposit first.`);
    }
  }
  if (to === 'delivered') {
    const open = ledger.milestones.filter((m) => !m.accepted).map((m) => m.id);
    if (open.length) {
      throw new Error(`Cannot mark ${ledger.clientRef} delivered: milestone(s) not accepted — ${open.join(', ')}.`);
    }
    const owed = round(ledger.planned.projectPrice - totalReceipts(ledger));
    if (owed > 0) {
      throw new Error(`Cannot mark ${ledger.clientRef} delivered: $${owed} of the $${ledger.planned.projectPrice} price is still outstanding.`);
    }
  }

  ledger.state = to;
  ledger.history.push({ at: nowIso(at), to, note: note || null });
  return ledger;
}

/** Record the proposal going out. */
function recordProposalSent(ledger, { at, note } = {}) {
  assertActive(ledger);
  ledger.proposalSentAt = nowIso(at);
  return transition(ledger, 'proposed', { at, note: note || 'Proposal issued.' });
}

/** Record money in from the client. */
function recordReceipt(ledger, { amount, kind = 'deposit', at, reference } = {}) {
  if (!['deposit', 'balance', 'retainer', 'change-order'].includes(kind)) {
    throw new Error(`Unknown receipt kind "${kind}".`);
  }
  // Retainer money arrives for months after the build closes — that is the
  // point of the retainer, so a closed engagement must still accept it.
  assertActive(ledger, { allowClosed: POST_CLOSE_RECEIPT_KINDS.includes(kind) });
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('A positive receipt amount is required.');
  ledger.receipts.push({ amount: round(value), kind, at: nowIso(at), reference: reference || null });
  return ledger;
}

/** Record our own software/operating spend on this engagement. */
function recordOpsSpend(ledger, { amount, description, at } = {}) {
  // Hosting and model usage keep costing money while the retainer runs.
  assertActive(ledger, { allowClosed: true });
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('A positive spend amount is required.');
  ledger.opsSpend.push({ amount: round(value), description: description || null, at: nowIso(at) });
  return ledger;
}

/**
 * Accept a milestone, from a qc.evaluateMilestone() result.
 *
 * The QC result is the authority: an evaluation that is not `accepted` is
 * refused here rather than recorded with a caveat. This is the same rule qc.js
 * enforces on payment release, held at the persistence boundary too so a
 * milestone cannot be marked accepted by editing a flag.
 */
function acceptMilestone(ledger, evaluation, { at } = {}) {
  assertActive(ledger);
  if (ledger.state !== 'in_delivery') {
    throw new Error(`Cannot accept a milestone while ${ledger.clientRef} is ${ledger.state}. Move to in_delivery first.`);
  }
  if (!evaluation || !evaluation.milestoneId) throw new TypeError('A qc.evaluateMilestone() result is required.');
  // The evaluation must be a real one. Without this check, `{milestoneId,
  // accepted: true}` would record an acceptance no checklist ever produced,
  // making the ten blocking items decorative.
  if (evaluation.gate !== 'qc.evaluateMilestone' || !Array.isArray(evaluation.openItems)) {
    throw new Error(`Cannot accept ${evaluation.milestoneId}: acceptance must come from qc.evaluateMilestone(). Run the checklist.`);
  }
  if (evaluation.accepted !== true || evaluation.openItems.length > 0) {
    throw new Error(`Cannot accept ${evaluation.milestoneId}: quality control has ${evaluation.openItems.length} blocking item(s) open.`);
  }
  if (!evaluation.reviewedBy) {
    throw new Error(`Cannot accept ${evaluation.milestoneId}: no reviewer named on the checklist. Somebody owns this sign-off.`);
  }
  const milestone = ledger.milestones.find((m) => m.id === evaluation.milestoneId);
  if (!milestone) throw new Error(`Milestone ${evaluation.milestoneId} is not part of ${ledger.clientRef}.`);
  if (milestone.accepted) throw new Error(`Milestone ${evaluation.milestoneId} is already accepted.`);

  milestone.accepted = true;
  milestone.acceptedAt = nowIso(at);
  milestone.reviewedBy = evaluation.reviewedBy || null;
  ledger.history.push({ at: nowIso(at), to: ledger.state, note: `Milestone accepted: ${evaluation.milestoneId}` });
  return ledger;
}

/**
 * Release a contractor's fixed-price payment for an accepted milestone.
 *
 * Refused unless the milestone is accepted — the QC gate is the only route to a
 * payment, and paying "just to keep them moving" on unaccepted work is the exact
 * habit that makes the gate decorative.
 */
function releasePayment(ledger, { milestoneId, contractorId, amount, at, reference } = {}) {
  // A final contractor payment can legitimately clear after the build closes.
  assertActive(ledger, { allowClosed: true });
  const milestone = ledger.milestones.find((m) => m.id === milestoneId);
  if (!milestone) throw new Error(`Milestone ${milestoneId} is not part of ${ledger.clientRef}.`);
  if (!milestone.accepted) {
    throw new Error(`Cannot release payment for ${milestoneId}: it is not accepted. Quality control gates payment.`);
  }
  if (milestone.paid) throw new Error(`Milestone ${milestoneId} is already paid.`);

  const planned = (ledger.planned.milestones.find((m) => m.id === milestoneId) || {}).developerPayout || 0;
  const value = amount === undefined ? planned : Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Payment amount must be a non-negative number.');

  milestone.paid = true;
  ledger.payments.push({
    milestoneId,
    contractorId: contractorId || null,
    amount: round(value),
    planned: round(planned),
    variance: round(value - planned),
    at: nowIso(at),
    reference: reference || null,
  });
  return ledger;
}

function plannedPayout(ledger, milestoneId) {
  if (!ledger.planned) return 0;
  const m = ledger.planned.milestones.find((pm) => pm.id === milestoneId);
  return m ? m.developerPayout : 0;
}

/**
 * Record a ticket assignment produced by contractor.assignTicket().
 *
 * assignTicket() is the gate — it throws on unpapered contractors and stamps the
 * access tier. This only stores the result, and refuses a payload that did not
 * come from that gate, for the same reason milestone acceptance refuses anything
 * without a QC stamp: a hand-built assignment would have skipped the paperwork
 * check that makes the work ours.
 */
function recordAssignment(ledger, assignment) {
  assertActive(ledger);
  normalize(ledger);
  if (!assignment || !assignment.ticketId || !assignment.contractorId) {
    throw new TypeError('A contractor.assignTicket() result is required.');
  }
  if (assignment.billing !== 'fixed-price-on-acceptance' || !assignment.accessTier) {
    throw new Error(`Assignment for ${assignment.ticketId} did not come from contractor.assignTicket(). Assign through the gate.`);
  }
  const open = ledger.assignments.find((a) => a.ticketId === assignment.ticketId && !a.releasedAt);
  if (open) {
    throw new Error(`Ticket ${assignment.ticketId} is already assigned to ${open.contractorId}. Release it before reassigning.`);
  }
  ledger.assignments.push({
    ticketId: assignment.ticketId,
    milestoneId: assignment.milestoneId || null,
    contractorId: assignment.contractorId,
    fixedPrice: round(assignment.fixedPrice),
    accessTier: assignment.accessTier,
    assignedAt: assignment.assignedAt,
    releasedAt: null,
    outcome: null,
  });
  return ledger;
}

/**
 * Close out an assignment. `outcome` is what the bench's track record is built
 * from, so it distinguishes work that passed quality control first time from
 * work that had to go back — the second kind costs more than the fixed price
 * saved by picking a cheaper contractor.
 */
function releaseAssignment(ledger, { ticketId, outcome = 'completed', at } = {}) {
  assertActive(ledger, { allowClosed: true });
  normalize(ledger);
  if (!['completed', 'completed-after-rework', 'reassigned', 'abandoned'].includes(outcome)) {
    throw new Error(`Unknown assignment outcome "${outcome}".`);
  }
  const assignment = ledger.assignments.find((a) => a.ticketId === ticketId && !a.releasedAt);
  if (!assignment) throw new Error(`No open assignment for ticket ${ticketId} on ${ledger.clientRef}.`);
  assignment.releasedAt = nowIso(at);
  assignment.outcome = outcome;
  return ledger;
}

/** Assignments currently held, optionally filtered to one contractor. */
function openAssignments(ledger, contractorId) {
  return (ledger.assignments || []).filter((a) => !a.releasedAt && (!contractorId || a.contractorId === contractorId));
}

function totalReceipts(ledger, kind) {
  return round(ledger.receipts
    .filter((r) => !kind || r.kind === kind)
    .reduce((sum, r) => sum + r.amount, 0));
}

function totalPayments(ledger) {
  return round(ledger.payments.reduce((sum, p) => sum + p.amount, 0));
}

function totalOpsSpend(ledger) {
  return round(ledger.opsSpend.reduce((sum, s) => sum + s.amount, 0));
}

/**
 * Actual economics to date, and how they compare to the plan.
 *
 * `cashPosition` is real money held: everything in, minus everything out. It can
 * legitimately be negative only if we broke the deposit rule, which is why it is
 * surfaced rather than buried.
 */
function economics(ledger) {
  const received = totalReceipts(ledger);
  const buildReceived = round(totalReceipts(ledger, 'deposit') + totalReceipts(ledger, 'balance') + totalReceipts(ledger, 'change-order'));
  const retainerReceived = totalReceipts(ledger, 'retainer');
  const paid = totalPayments(ledger);
  const ops = totalOpsSpend(ledger);
  const cashPosition = round(received - paid - ops);

  const planned = ledger.planned;
  const grossProfit = round(buildReceived - paid - ops);
  const grossMarginPct = buildReceived > 0 ? round((grossProfit / buildReceived) * 100, 1) : 0;
  // Mid-build, `grossProfit` is just cash-in minus cash-out-so-far: the deposit
  // arrives before any contractor is paid, so it reads as a 100% margin. That is
  // a cash position, not a profit, and anyone reporting it as profit is lying to
  // themselves. Final only once the build is fully collected and paid out.
  const profitIsFinal = ledger.state === 'delivered' || ledger.state === 'closed';

  const result = {
    state: ledger.state,
    received,
    buildReceived,
    retainerReceived,
    developerPaid: paid,
    opsSpent: ops,
    cashPosition,
    grossProfit,
    grossMarginPct,
    profitIsFinal,
    milestonesAccepted: ledger.milestones.filter((m) => m.accepted).length,
    milestonesTotal: ledger.milestones.length,
    outstandingFromClient: planned ? round(Math.max(planned.projectPrice - buildReceived, 0)) : 0,
    // Only milestones that actually carry a contractor payment. The discovery
    // and architecture milestone is ours and has a zero payout, so listing it as
    // "accepted but unpaid" would put a permanent false alarm on every ledger.
    unpaidAcceptedMilestones: ledger.milestones
      .filter((m) => m.accepted && !m.paid && plannedPayout(ledger, m.id) > 0)
      .map((m) => m.id),
  };

  if (planned) {
    result.variance = {
      developerCost: round(paid - planned.developerCost),
      opsCost: round(ops - planned.opsCost),
      grossProfit: round(grossProfit - planned.grossProfit),
      // Only meaningful once the build is fully collected and paid out.
      final: ledger.state === 'delivered' || ledger.state === 'closed',
    };
  }
  return result;
}

/**
 * What to do next on this engagement. A ledger that does not tell you the next
 * action is a ledger nobody opens.
 */
function nextAction(ledger) {
  const e = economics(ledger);
  switch (ledger.state) {
    case 'qualified':
      return 'Send the proposal, then record it with recordProposalSent().';
    case 'proposed':
      return `Awaiting signature and the $${ledger.planned.depositAmount.toLocaleString('en-US')} deposit. Chase it — a proposal with no deposit is not a project.`;
    case 'won':
      return 'Deposit is in. Assign tickets to papered contractors and move to in_delivery.';
    case 'in_delivery': {
      if (e.unpaidAcceptedMilestones.length) {
        return `Release payment for accepted milestone(s): ${e.unpaidAcceptedMilestones.join(', ')}.`;
      }
      const open = ledger.milestones.filter((m) => !m.accepted).map((m) => m.id);
      return `Run quality control on the next milestone: ${open[0]}. ${open.length} of ${ledger.milestones.length} still open.`;
    }
    case 'delivered':
      return e.unpaidAcceptedMilestones.length
        ? `Settle the final contractor payment(s): ${e.unpaidAcceptedMilestones.join(', ')}, then close.`
        : 'Start the retainer or optimization cadence, then close the engagement.';
    case 'closed':
      return 'Complete. Feed the delivery-cost variance back into the estimates in engagement.js.';
    case 'lost':
      return 'Lost. Record why in the history if it is not already there.';
    case 'disqualified':
      return 'Disqualified at qualification. Do not re-work without new facts.';
    default:
      return 'Unknown state.';
  }
}

module.exports = {
  normalize,
  STATES,
  TRANSITIONS,
  TERMINAL,
  DEAD,
  POST_CLOSE_RECEIPT_KINDS,
  assertActive,
  PIPELINE_WEIGHTS,
  openLedger,
  transition,
  recordProposalSent,
  recordReceipt,
  recordOpsSpend,
  acceptMilestone,
  releasePayment,
  recordAssignment,
  releaseAssignment,
  openAssignments,
  plannedPayout,
  totalReceipts,
  totalPayments,
  totalOpsSpend,
  economics,
  nextAction,
};

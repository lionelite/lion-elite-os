'use strict';

// Dispute resolution when quality control rejects a contractor's work.
//
// THE HOLE THIS FILLS. `qc.js` refuses acceptance and `ledger.js` refuses
// payment. Both are one-directional and final: a contractor who genuinely
// believes their ticket meets the acceptance criteria had nowhere to go. That is
// three separate problems at once —
//
//   unfair: we hold the money, the review, and the definition of done;
//   legally exposed: an unpaid contractor with no process is a claim;
//   operationally bad: a stuck ticket blocks its milestone, which blocks the
//   client's balance payment.
//
// THE RULE THAT MAKES THIS MORE THAN A COMPLAINT BOX. A ruling must cite the
// specific acceptance criterion it turns on. That is the whole reason
// `delivery-plan.js` refuses to emit a ticket without objective criteria: a
// dispute over objective criteria is *resolvable by reading them*. A ruling that
// cites nothing is refused here, because "we looked at it and we're right" is how
// arbitration becomes theatre in which the agency always wins.
//
// AMBIGUITY IS OUR FAULT. If the criterion turns out to be ambiguous, we wrote
// the ticket — that is a spec defect, not contractor underperformance. The
// `split` outcome pays the contractor and records the defect against us. The
// incentive that creates is the correct one: we write clearer tickets. Repeated
// ambiguity findings are a signal to fix the templates in `delivery-plan.js`,
// which is why `specDefectRate()` exists.
//
// THE REVIEWER CANNOT BE THE PERSON WHO FAILED IT. Enforced, not encouraged.
// Without that, the appeal is to the same judgement being appealed.
//
// NOT LEGAL ADVICE. This is the internal process that must be exhausted before
// any external forum. The forum itself, and whether arbitration binds, is an
// agreement term for an attorney — see
// `agency/templates/contractor-agreement-terms.md`.

// Business days a dispute may stay open before it escalates on its own.
// Deliberately short: "we'll get to it" is how a contractor goes a month unpaid.
const DECISION_WINDOW_DAYS = 5;

const OUTCOMES = Object.freeze({
  upheld: 'Quality control was right. The contractor reworks the ticket at no additional cost.',
  overturned: 'The contractor was right. The work meets the criteria; accept the milestone and release payment.',
  split: 'The acceptance criterion was ambiguous. Our spec defect — pay the contractor in full and fix the criterion.',
  withdrawn: 'The contractor withdrew the dispute.',
});

// Outcomes that mean the contractor gets paid for the work as submitted.
const PAYS_CONTRACTOR = Object.freeze(['overturned', 'split']);

// Outcomes that record a defect against our own specification, not the
// contractor's delivery.
const OUR_DEFECT = Object.freeze(['split']);

const STATUSES = Object.freeze(['open', 'decided', 'escalated']);

function nowIso(at) {
  if (!at) return new Date().toISOString();
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid timestamp: ${at}`);
  return d.toISOString();
}

function addBusinessDays(from, days) {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return d;
}

/**
 * Open a dispute against a failed QC evaluation.
 *
 * Requires the real evaluation, for the same reason acceptance does: a dispute
 * against a rejection that no checklist produced has nothing to adjudicate. And
 * a dispute can only be opened against a rejection — contesting an acceptance is
 * incoherent.
 */
function openDispute({ evaluation, ticketId, contractorId, contractorPosition, at } = {}) {
  if (!evaluation || evaluation.gate !== 'qc.evaluateMilestone') {
    throw new Error('A dispute must reference a real qc.evaluateMilestone() result.');
  }
  if (evaluation.accepted === true) {
    throw new Error(`Milestone ${evaluation.milestoneId} was accepted — there is nothing to dispute.`);
  }
  if (!ticketId) throw new TypeError('ticketId is required — disputes are per ticket, not per milestone.');
  if (!contractorId) throw new TypeError('contractorId is required.');
  if (!contractorPosition || String(contractorPosition).trim().length < 15) {
    throw new Error('The contractor must state which criterion they believe is met and why. A dispute with no stated position cannot be adjudicated.');
  }

  const openedAt = nowIso(at);
  // The items actually in dispute: the blocking items QC left open. Anything
  // outside this list is out of scope for the ruling.
  const contested = (evaluation.openItems || []).map((i) => ({ id: i.id, label: i.label, kind: i.kind }));

  return {
    ticketId,
    milestoneId: evaluation.milestoneId,
    contractorId,
    status: 'open',
    openedAt,
    decideBy: addBusinessDays(new Date(openedAt), DECISION_WINDOW_DAYS).toISOString(),
    contractorPosition: String(contractorPosition).trim(),
    // Who ran the failing review. They are barred from deciding the appeal.
    qcReviewedBy: evaluation.reviewedBy || null,
    contestedItems: contested,
    decision: null,
  };
}

/**
 * Decide a dispute.
 *
 * Refused unless: the reviewer is someone other than whoever failed it, the
 * outcome is known, and — for a substantive outcome — the ruling cites at least
 * one contested acceptance item. A `withdrawn` dispute needs no citation because
 * nobody ruled on anything.
 */
function decideDispute(dispute, { outcome, decidedBy, citedItems = [], rationale, at } = {}) {
  if (!dispute || dispute.status === undefined) throw new TypeError('A dispute is required.');
  if (dispute.status !== 'open') {
    throw new Error(`Dispute on ${dispute.ticketId} is already ${dispute.status}.`);
  }
  if (!OUTCOMES[outcome]) {
    throw new Error(`Unknown dispute outcome "${outcome}". Expected one of ${Object.keys(OUTCOMES).join(', ')}.`);
  }
  if (!decidedBy) throw new TypeError('decidedBy is required — somebody owns this ruling.');

  // The core fairness property.
  if (dispute.qcReviewedBy && decidedBy === dispute.qcReviewedBy) {
    throw new Error(`${decidedBy} ran the failing review and cannot decide the appeal against it. Route it to someone else.`);
  }

  if (outcome !== 'withdrawn') {
    if (!Array.isArray(citedItems) || citedItems.length === 0) {
      throw new Error('A ruling must cite the acceptance item(s) it turns on. Objective criteria exist so a dispute is resolvable by reading them.');
    }
    const known = new Set(dispute.contestedItems.map((i) => i.id));
    const unknown = citedItems.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(`Cited item(s) not in dispute: ${unknown.join(', ')}. A ruling cannot turn on something quality control never raised.`);
    }
    if (!rationale || String(rationale).trim().length < 15) {
      throw new Error('A ruling needs a stated rationale the contractor can read.');
    }
  }

  return {
    ...dispute,
    status: 'decided',
    decision: {
      outcome,
      meaning: OUTCOMES[outcome],
      decidedBy,
      decidedAt: nowIso(at),
      citedItems: [...citedItems],
      rationale: rationale ? String(rationale).trim() : null,
      paysContractor: PAYS_CONTRACTOR.includes(outcome),
      // A split means our specification failed, and that is recorded against us.
      ourSpecDefect: OUR_DEFECT.includes(outcome),
      // Overturned means our QC called it wrong — also worth counting.
      ourQcError: outcome === 'overturned',
    },
  };
}

/**
 * Has an open dispute blown its decision window?
 *
 * An overdue dispute escalates rather than sitting open, because an indefinite
 * "under review" is functionally a refusal to pay.
 */
function isOverdue(dispute, { asOf = new Date() } = {}) {
  if (dispute.status !== 'open') return false;
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  return now > new Date(dispute.decideBy);
}

/** Escalate an overdue or deadlocked dispute to the agreement's external forum. */
function escalate(dispute, { reason, at } = {}) {
  if (dispute.status === 'decided') {
    throw new Error(`Dispute on ${dispute.ticketId} is already decided. Escalation is for undecided disputes.`);
  }
  if (dispute.status === 'escalated') throw new Error(`Dispute on ${dispute.ticketId} is already escalated.`);
  return {
    ...dispute,
    status: 'escalated',
    escalatedAt: nowIso(at),
    escalationReason: reason || `Not decided within ${DECISION_WINDOW_DAYS} business days.`,
    note: 'Internal process is exhausted. The external forum and whether it binds are agreement terms — see agency/templates/contractor-agreement-terms.md.',
  };
}

/**
 * What must happen now as a result of this dispute.
 *
 * Returned as instructions rather than performed, so the ledger stays the only
 * thing that moves money.
 */
function requiredActions(dispute) {
  if (dispute.status === 'open') {
    return [
      `Assign a reviewer who is not ${dispute.qcReviewedBy || 'the original reviewer'}.`,
      `Decide by ${dispute.decideBy.slice(0, 10)} or it escalates.`,
      'Payment on this ticket is held until the ruling.',
    ];
  }
  if (dispute.status === 'escalated') {
    return [
      'Internal process exhausted — follow the agreement\'s dispute clause.',
      'Do not leave the contractor unpaid and unanswered while this runs.',
    ];
  }
  const { outcome } = dispute.decision;
  if (outcome === 'upheld') {
    return [
      'Return the ticket to the contractor for rework at no additional cost.',
      'Re-run quality control when it comes back.',
    ];
  }
  if (outcome === 'overturned') {
    return [
      'Re-run quality control recording the contested items as passed — the ruling is the evidence.',
      'Accept the milestone and release the contractor\'s fixed price.',
      'Review why quality control called this wrong; a pattern here means our gate is too harsh.',
    ];
  }
  if (outcome === 'split') {
    return [
      'Pay the contractor in full — the criterion was ours to write clearly.',
      'Rewrite the ambiguous acceptance criterion before the next ticket uses it.',
      'If this keeps happening, fix the ticket templates in delivery-plan.js.',
    ];
  }
  return ['Dispute withdrawn. Ticket returns to its prior state.'];
}

/**
 * Dispute statistics across a set of ledgers.
 *
 * Read this the right way round: a high overturn rate is a finding about OUR
 * quality control, and a high split rate is a finding about OUR specifications.
 * Only `upheld` is a finding about the contractor. An agency that reads its own
 * overturn rate as contractor noise never fixes its gate.
 */
function disputeStats(ledgers = []) {
  const disputes = ledgers.flatMap((l) => (l.disputes || []).map((d) => ({ ...d, clientRef: l.clientRef })));
  const decided = disputes.filter((d) => d.status === 'decided');
  const counts = decided.reduce((acc, d) => {
    acc[d.decision.outcome] = (acc[d.decision.outcome] || 0) + 1;
    return acc;
  }, {});

  const substantive = decided.filter((d) => d.decision.outcome !== 'withdrawn').length;
  const overturned = counts.overturned || 0;
  const split = counts.split || 0;

  const findings = [];
  if (substantive >= 3) {
    const overturnRate = overturned / substantive;
    const splitRate = split / substantive;
    if (overturnRate > 0.3) {
      findings.push(`${Math.round(overturnRate * 100)}% of disputes were overturned. That is a finding about our quality control, not about contractors — the gate is rejecting work that meets the criteria.`);
    }
    if (splitRate > 0.25) {
      findings.push(`${Math.round(splitRate * 100)}% of disputes turned on an ambiguous criterion. Our specifications are the problem; fix the ticket templates in delivery-plan.js.`);
    }
  }
  const open = disputes.filter((d) => d.status === 'open');
  for (const d of open.filter((x) => isOverdue(x))) {
    findings.push(`Dispute on ${d.ticketId} (${d.clientRef}) is past its ${d.decideBy.slice(0, 10)} deadline. Decide it or escalate — an indefinite review is a refusal to pay.`);
  }
  if (disputes.some((d) => d.status === 'escalated')) {
    findings.push(`${disputes.filter((d) => d.status === 'escalated').length} dispute(s) escalated beyond the internal process.`);
  }

  return {
    total: disputes.length,
    open: open.length,
    overdue: open.filter((d) => isOverdue(d)).length,
    escalated: disputes.filter((d) => d.status === 'escalated').length,
    decided: decided.length,
    outcomes: counts,
    // Rates only once there is enough to read; before that they are noise.
    overturnRate: substantive >= 3 ? Number((overturned / substantive).toFixed(3)) : null,
    specDefectRate: substantive >= 3 ? Number((split / substantive).toFixed(3)) : null,
    findings,
  };
}

/**
 * A contractor's dispute record. Deliberately separates "contested and was
 * right" from "contested and was wrong" — a contractor who successfully
 * challenges bad rejections is a good contractor, and a naive count of disputes
 * would penalise exactly the wrong person.
 */
function contractorDisputeRecord(contractorId, ledgers = []) {
  const theirs = ledgers.flatMap((l) => (l.disputes || []).filter((d) => d.contractorId === contractorId));
  const decided = theirs.filter((d) => d.status === 'decided');
  return {
    contractorId,
    disputesRaised: theirs.length,
    upheldAgainstThem: decided.filter((d) => d.decision.outcome === 'upheld').length,
    wonOutright: decided.filter((d) => d.decision.outcome === 'overturned').length,
    ourSpecFault: decided.filter((d) => d.decision.outcome === 'split').length,
    withdrawn: decided.filter((d) => d.decision.outcome === 'withdrawn').length,
    // Only upheld rulings say anything negative about their work.
    substantiveLosses: decided.filter((d) => d.decision.outcome === 'upheld').length,
  };
}

module.exports = {
  DECISION_WINDOW_DAYS,
  OUTCOMES,
  PAYS_CONTRACTOR,
  OUR_DEFECT,
  STATUSES,
  addBusinessDays,
  openDispute,
  decideDispute,
  isOverdue,
  escalate,
  requiredActions,
  disputeStats,
  contractorDisputeRecord,
};

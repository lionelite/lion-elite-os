'use strict';

// Quality control — the gate between "a contractor says it's done" and both
// (a) the client seeing it and (b) the contractor being paid.
//
// This is the load-bearing part of the whole model. We are not reselling cheap
// labour; what the client is buying is that someone competent checked the work
// before it reached them. If this gate is soft, the agency is an unreliable
// middleman and the retainer never renews.
//
// Design: every checklist item is either BLOCKING or advisory. A milestone is
// accepted only when every blocking item passes AND every acceptance test on the
// milestone is recorded as passed. Unknown/unrecorded counts as not passed —
// fail-closed, the same posture as outreach validation. Payment release is
// derived from acceptance, never set directly.

// Blocking items apply to every milestone.
const BLOCKING_ITEMS = Object.freeze([
  Object.freeze({ id: 'acceptance-tests', label: 'Every acceptance test on the milestone is recorded as passed.' }),
  Object.freeze({ id: 'code-review', label: 'Reviewed by us, not by the author. Reviewer named.' }),
  Object.freeze({ id: 'ci-green', label: 'CI passes on the merge commit in our pipeline.' }),
  Object.freeze({ id: 'no-secrets-committed', label: 'No credential, key or token in the diff or history.' }),
  Object.freeze({ id: 'failure-paths', label: 'Failure paths handled — no path silently drops a lead.' }),
  Object.freeze({ id: 'owned-infrastructure', label: 'Runs on our infrastructure under our accounts.' }),
  Object.freeze({ id: 'ip-clear', label: 'Contractor\'s IP assignment covers every commit in the milestone.' }),
  Object.freeze({ id: 'docs-updated', label: 'Runbook and admin docs updated for what changed.' }),
  Object.freeze({ id: 'no-contractor-client-contact', label: 'No contractor contact with the client occurred outside our channel.' }),
  Object.freeze({ id: 'demo-recorded', label: 'Demo recorded against the client\'s own scenario.' }),
]);

// Advisory items: recorded, reported, but do not hold payment on their own.
const ADVISORY_ITEMS = Object.freeze([
  Object.freeze({ id: 'performance-budget', label: 'Within the agreed performance budget on realistic data volume.' }),
  Object.freeze({ id: 'reusability', label: 'Anything reusable extracted into our shared library for the next build.' }),
  Object.freeze({ id: 'estimate-variance', label: 'Actual effort vs. the fixed price captured for future estimating.' }),
]);

function newChecklist(milestoneId) {
  return {
    milestoneId,
    results: {},
    reviewedBy: null,
    notes: [],
  };
}

/**
 * Record a check result. `passed` must be an explicit boolean — passing
 * undefined records nothing and the item stays failed, which is the point.
 */
function record(checklist, itemId, passed, note) {
  const known = [...BLOCKING_ITEMS, ...ADVISORY_ITEMS].some((i) => i.id === itemId);
  if (!known) throw new Error(`Unknown QC item "${itemId}".`);
  if (typeof passed !== 'boolean') throw new TypeError(`QC result for "${itemId}" must be an explicit boolean.`);
  checklist.results[itemId] = { passed, note: note || null, at: new Date().toISOString() };
  return checklist;
}

/**
 * Evaluate the gate for one milestone.
 *
 * `milestone.acceptanceTests` are cross-checked against `testResults`, a map of
 * acceptance-test id → boolean. A test with no recorded result is treated as
 * failed and named in `openItems`.
 */
function evaluateMilestone(milestone, checklist, testResults = {}) {
  if (!milestone || !milestone.id) throw new TypeError('A milestone with an id is required.');
  const list = checklist && checklist.results ? checklist.results : {};

  const openItems = [];
  const advisoryOpen = [];

  const untestedAcceptance = (milestone.acceptanceTests || []).filter((t) => testResults[t.id] !== true);
  for (const t of untestedAcceptance) {
    openItems.push({ id: t.id, label: `Acceptance test not passed: ${t.statement}`, kind: 'acceptance-test' });
  }

  for (const item of BLOCKING_ITEMS) {
    // The acceptance-tests checklist item is derived, not self-asserted: it
    // cannot be ticked while an acceptance test is outstanding.
    if (item.id === 'acceptance-tests') {
      if (untestedAcceptance.length > 0) {
        openItems.push({ id: item.id, label: item.label, kind: 'blocking', derived: true });
      }
      continue;
    }
    const result = list[item.id];
    if (!result || result.passed !== true) {
      openItems.push({ id: item.id, label: item.label, kind: 'blocking' });
    }
  }

  for (const item of ADVISORY_ITEMS) {
    const result = list[item.id];
    if (!result || result.passed !== true) advisoryOpen.push({ id: item.id, label: item.label, kind: 'advisory' });
  }

  if (!checklist || !checklist.reviewedBy) {
    openItems.push({ id: 'reviewer-named', label: 'No reviewer recorded on the checklist.', kind: 'blocking' });
  }

  const accepted = openItems.length === 0;

  return {
    // Provenance stamp. ledger.acceptMilestone() requires it, so a hand-built
    // `{accepted: true}` object cannot be used to record an acceptance that no
    // checklist ever produced. This guards against mistakes and sloppy
    // automation, not against someone determined to forge the field — nothing
    // in-process can do that — but it makes the bypass loud instead of silent.
    gate: 'qc.evaluateMilestone',
    milestoneId: milestone.id,
    accepted,
    // Payment is a consequence of acceptance. There is no way to release payment
    // with a blocking item open.
    releaseDeveloperPayment: accepted,
    developerPayout: accepted ? milestone.developerPayout : 0,
    // Only the final milestone triggers the client's balance invoice.
    invoiceClientBalance: accepted && milestone.triggersClientBalance === true,
    openItems,
    advisoryOpen,
    reviewedBy: checklist ? checklist.reviewedBy || null : null,
    summary: accepted
      ? `Milestone ${milestone.id} accepted. Release $${milestone.developerPayout} fixed-price payment.`
      : `Milestone ${milestone.id} NOT accepted — ${openItems.length} blocking item(s) open. No payment released, nothing shown to the client.`,
  };
}

/**
 * Whether the engagement as a whole is deliverable to the client.
 * `evaluations` is the list of per-milestone evaluations.
 */
function evaluateEngagement(milestones, evaluations) {
  const byId = new Map(evaluations.map((e) => [e.milestoneId, e]));
  const outstanding = milestones.filter((m) => {
    const e = byId.get(m.id);
    return !e || !e.accepted;
  }).map((m) => m.id);
  return {
    complete: outstanding.length === 0,
    outstandingMilestones: outstanding,
    acceptedCount: milestones.length - outstanding.length,
    totalMilestones: milestones.length,
  };
}

module.exports = {
  BLOCKING_ITEMS,
  ADVISORY_ITEMS,
  newChecklist,
  record,
  evaluateMilestone,
  evaluateEngagement,
};

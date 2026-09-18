'use strict';

// Closes the loop Issue #73 actually asks for.
//
// `coordinator.js` produces assignments. Until this file existed, nothing turned
// them into dispatched work or recorded what happened — so the roster was a
// planner, and #73's definition of done ("it triggers agent jobs, records their
// actions and outcomes") was unmet. This dispatches each assignment through the
// existing allowlisted dispatcher and records the result.
//
// THE DISTINCTION THIS FILE REFUSES TO BLUR: a queued job is not a finished job.
// The runner knows it enqueued something; it does not know the work succeeded.
// So a successful dispatch records `dispatched`, never `completed`. CLAUDE.md's
// working agreement names this exact failure — "a merged commit, a green build,
// or a fired deploy hook is not evidence the thing works" — and an agent roster
// that logged `completed` on enqueue would manufacture a clean daily report out
// of nothing but successful queue writes.
//
// IT WEAKENS NOTHING. `canExecute()` in the dispatcher requires either
// `approvalMode === 'automatic'` or an action explicitly marked
// `requiresApproval: false`. This runner sets neither on its own: it passes
// through whatever approval mode its caller was configured with and reports
// honestly when the answer is "a human has to approve this". Marking the
// assignments pre-approved from in here would be bypassing a control, which the
// hard limits forbid.
//
// `dispatch` is injected so this is unit-testable without bullmq or Redis — the
// same reason `action-catalog.js` and `integration-normalization.js` exist.

const { recordOutcome } = require('./coordinator');
const { hasConsumer } = require('../action-catalog');

// How the dispatcher's vocabulary maps onto ours. Note there is no mapping to
// `completed`: nothing this module observes can justify that word.
const DISPATCH_STATUS = Object.freeze({
  queued: 'dispatched',
  'not-executed': 'blocked',
});

/**
 * Convert an assignment into the shape `dispatchAction()` expects.
 *
 * `requiresApproval` is deliberately left unset. The dispatcher's default is to
 * require approval, and that default is a control, not an inconvenience.
 */
function toDispatchableAction(assignment) {
  if (!assignment || !assignment.action) throw new TypeError('An assignment with an action is required.');
  return {
    id: `agent:${assignment.roleId}:${assignment.action}`,
    type: 'queue-action',
    payload: {
      action: assignment.action,
      roleId: assignment.roleId,
      reason: assignment.reason,
    },
  };
}

/**
 * Dispatch one checkpoint's assignments.
 *
 * Returns recorded outcomes plus a report. Never throws on a single failure —
 * one refused assignment must not abandon the rest of the day's work — but every
 * failure is recorded with its reason rather than swallowed.
 */
async function runCheckpoint(plan, { dispatch, approvalMode, requestedBy = 'agent-coordinator' } = {}) {
  if (!plan || !Array.isArray(plan.assignments)) throw new TypeError('A coordinator.planCheckpoint() result is required.');
  if (typeof dispatch !== 'function') throw new TypeError('A dispatch function is required (inject the real dispatcher at the edge).');

  const outcomes = [];
  for (const assignment of plan.assignments) {
    try {
      const result = await dispatch(toDispatchableAction(assignment), { approvalMode, requestedBy });
      const status = DISPATCH_STATUS[result && result.status] || 'failed';
      // A job on a queue nobody consumes is enqueued, not underway. The
      // dispatcher cannot tell the difference — it returns `queued` either way —
      // so say it here rather than let a no-op read as progress.
      const orphaned = status === 'dispatched' && !hasConsumer(assignment.action);
      let detail;
      if (status === 'blocked') detail = `Dispatcher refused: ${result.reason}`;
      else if (status === 'dispatched') {
        detail = `Queued as ${result.jobId || result.executionId} on ${result.queue}`;
        if (orphaned) detail += ` — NO WORKER consumes "${assignment.queue}", so this will not be processed`;
      } else detail = `Unexpected dispatcher status: ${result && result.status}`;
      const recorded = recordOutcome(assignment, { outcome: status, detail });
      recorded.orphanedQueue = orphaned;
      outcomes.push(recorded);
    } catch (error) {
      // A thrown dispatch is a real failure — usually no queue connection.
      outcomes.push(recordOutcome(assignment, { outcome: 'failed', detail: error.message }));
    }
  }

  return { checkpoint: plan.checkpoint, gap: plan.gap, outcomes, report: summarizeRun(plan, outcomes) };
}

/**
 * Summarise a run, and say plainly when nothing actually moved.
 *
 * The three ways a checkpoint can be useless are distinguished, because they
 * need different fixes: nothing dispatched (no queue), everything awaiting a
 * person (approval mode), or dispatched-but-gated (the send switches are off, so
 * work will be drafted and go nowhere).
 */
function summarizeRun(plan, outcomes) {
  const byStatus = outcomes.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});

  const awaitingApproval = outcomes.filter((o) => o.status === 'blocked' && /HUMAN_APPROVAL_REQUIRED/.test(o.detail || '')).length;
  const notAllowlisted = outcomes.filter((o) => o.status === 'blocked' && /ACTION_NOT_ALLOWLISTED|BLOCKED_SENSITIVE_ACTION/.test(o.detail || '')).length;
  const dispatched = byStatus.dispatched || 0;
  const failed = byStatus.failed || 0;
  const gatedFollowThrough = outcomes.filter((o) => (o.blockedFollowThrough || []).length > 0).length;
  const orphaned = outcomes.filter((o) => o.orphanedQueue);
  const effectivelyDispatched = dispatched - orphaned.length;

  const notes = [];
  if (notAllowlisted > 0) {
    // This should be impossible: the registry validates every action against the
    // allowlist. If it happens, the registry and the dispatcher have drifted.
    notes.push(`${notAllowlisted} assignment(s) were refused as not-allowlisted. The registry validates against the dispatcher, so this means they have drifted — check lib/agents/roles.js against lib/action-catalog.js.`);
  }
  if (awaitingApproval > 0) {
    notes.push(`${awaitingApproval} assignment(s) need a person to approve them. Nothing was bypassed; run with an automatic approval mode only if that is a deliberate operator decision.`);
  }
  if (failed > 0) {
    notes.push(`${failed} assignment(s) could not be dispatched at all — usually no queue connection. These did not run.`);
  }
  if (orphaned.length > 0) {
    notes.push(`${orphaned.length} assignment(s) went to a queue no worker consumes (${[...new Set(orphaned.map((o) => o.queue))].join(', ')}) and will NOT be processed: ${orphaned.map((o) => o.action).join(', ')}. Either the workers need writing or those actions should leave the dispatcher allowlist — an owner decision.`);
  }
  if (dispatched > 0 && gatedFollowThrough > 0) {
    notes.push(`${gatedFollowThrough} dispatched assignment(s) have gated follow-through (${plan.gatesClosed.join(', ')}). The work will be drafted and will not leave until a human opens a gate.`);
  }

  let verdict;
  if (dispatched === 0) {
    verdict = `${plan.checkpoint}: nothing was dispatched. ${notes.length ? notes[0] : 'No assignments were produced.'}`;
  } else if (effectivelyDispatched === 0) {
    verdict = `${plan.checkpoint}: ${dispatched} assignment(s) queued but EVERY ONE went to a queue with no worker. Nothing will be processed.`;
  } else {
    verdict = `${plan.checkpoint}: ${effectivelyDispatched} of ${outcomes.length} assignment(s) queued to a consumed queue${orphaned.length ? ` (${orphaned.length} more went nowhere)` : ''}. Queued is not completed — the jobs have been handed to the queue, not observed finishing.`;
  }

  return {
    checkpoint: plan.checkpoint,
    assignments: outcomes.length,
    byStatus,
    dispatched,
    effectivelyDispatched,
    orphanedQueue: orphaned.length,
    awaitingApproval,
    failed,
    gatedFollowThrough,
    notes,
    verdict,
  };
}

/**
 * Run every checkpoint of a planned day. Sequential on purpose: a later
 * checkpoint's plan depends on what the earlier ones established.
 */
async function runDay(plans, options) {
  const runs = [];
  for (const plan of plans) runs.push(await runCheckpoint(plan, options));
  return runs;
}

module.exports = {
  DISPATCH_STATUS,
  toDispatchableAction,
  runCheckpoint,
  summarizeRun,
  runDay,
};

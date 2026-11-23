const test = require('node:test');
const assert = require('node:assert/strict');
const runner = require('../lib/agents/runner');
const coordinator = require('../lib/agents/coordinator');

const ALL_OPEN = {
  OUTREACH_SEND_ENABLED: 'true',
  SMS_SEND_ENABLED: 'true',
  SOCIAL_PUBLISH_ENABLED: 'true',
};

function plan(overrides = {}) {
  return coordinator.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_OPEN, ...overrides });
}

const queued = async (action) => ({ status: 'queued', jobId: `ai:${action.payload.action}:1`, queue: 'analytics', executionId: 'e1' });
const refused = (reason) => async () => ({ status: 'not-executed', reason });

test('an assignment becomes a dispatchable action without being pre-approved', () => {
  const action = runner.toDispatchableAction({ roleId: 'sales', action: 'draft-outreach', reason: 'behind pace' });
  assert.equal(action.payload.action, 'draft-outreach');
  assert.equal(action.type, 'queue-action');
  // The dispatcher defaults to requiring approval. Setting this from here would
  // be bypassing a control.
  assert.equal(action.requiresApproval, undefined);
  assert.equal('requiresApproval' in action, false);
});

test('a malformed assignment is refused', () => {
  assert.throws(() => runner.toDispatchableAction(null), TypeError);
  assert.throws(() => runner.toDispatchableAction({ roleId: 'sales' }), TypeError);
});

test('a successful dispatch records "dispatched", never "completed"', async () => {
  const run = await runner.runCheckpoint(plan(), { dispatch: queued, approvalMode: 'automatic' });
  assert.ok(run.outcomes.length > 0);
  for (const o of run.outcomes) {
    assert.equal(o.status, 'dispatched');
    assert.notEqual(o.status, 'completed');
  }
  assert.equal(run.report.byStatus.completed, undefined, 'the runner must never claim completion');
  assert.match(run.report.verdict, /Queued is not completed/);
});

test('a refused dispatch is recorded as blocked with the dispatcher\'s reason', async () => {
  const run = await runner.runCheckpoint(plan(), { dispatch: refused('HUMAN_APPROVAL_REQUIRED') });
  for (const o of run.outcomes) {
    assert.equal(o.status, 'blocked');
    assert.match(o.detail, /HUMAN_APPROVAL_REQUIRED/);
  }
  assert.equal(run.report.awaitingApproval, run.outcomes.length);
  assert.ok(run.report.notes.some((n) => /Nothing was bypassed/.test(n)));
});

test('the default approval mode dispatches nothing, and says so rather than failing silently', async () => {
  const run = await runner.runCheckpoint(plan(), { dispatch: refused('HUMAN_APPROVAL_REQUIRED') });
  assert.equal(run.report.dispatched, 0);
  assert.match(run.report.verdict, /nothing was dispatched/);
});

test('a thrown dispatch is recorded as failed, not silently skipped', async () => {
  const run = await runner.runCheckpoint(plan(), {
    dispatch: async () => { throw new Error('Cannot find module bullmq'); },
    approvalMode: 'automatic',
  });
  assert.equal(run.report.failed, run.outcomes.length);
  assert.ok(run.outcomes.every((o) => /bullmq/.test(o.detail)));
  assert.ok(run.report.notes.some((n) => /These did not run/.test(n)));
});

test('one failure does not abandon the rest of the day\'s work', async () => {
  let calls = 0;
  const run = await runner.runCheckpoint(plan(), {
    approvalMode: 'automatic',
    dispatch: async (action) => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return queued(action);
    },
  });
  assert.equal(calls, run.outcomes.length, 'every assignment must still be attempted');
  assert.equal(run.report.failed, 1);
  assert.ok(run.report.dispatched > 0);
});

test('a job queued to a consumed queue counts as effectively dispatched', async () => {
  const p = coordinator.planCheckpoint('evening', { collectedToday: 4000, hour: 19, env: ALL_OPEN });
  const run = await runner.runCheckpoint(p, { dispatch: queued, approvalMode: 'automatic' });
  // Target met: only analytics assignments, all consumed.
  assert.equal(run.report.orphanedQueue, 0);
  assert.equal(run.report.effectivelyDispatched, run.report.dispatched);
});

test('a job queued to a queue with no worker is flagged, not counted as progress', async () => {
  const run = await runner.runCheckpoint(plan(), { dispatch: queued, approvalMode: 'automatic' });
  assert.ok(run.report.orphanedQueue > 0, 'the morning plan includes qualify-prospect, which has no worker');
  assert.ok(run.report.effectivelyDispatched < run.report.dispatched);
  const orphan = run.outcomes.find((o) => o.orphanedQueue);
  assert.match(orphan.detail, /NO WORKER consumes/);
  assert.ok(run.report.notes.some((n) => /will NOT be processed/.test(n)));
  assert.ok(run.report.notes.some((n) => /an owner decision/.test(n)));
});

test('when every dispatch lands in an unconsumed queue the verdict says nothing will be processed', async () => {
  // A plan of only orphaned actions.
  const p = plan();
  p.assignments = p.assignments.filter((a) => a.action === 'qualify-prospect');
  assert.ok(p.assignments.length > 0);
  const run = await runner.runCheckpoint(p, { dispatch: queued, approvalMode: 'automatic' });
  assert.equal(run.report.effectivelyDispatched, 0);
  assert.match(run.report.verdict, /EVERY ONE went to a queue with no worker/);
});

test('gated follow-through is reported even when dispatch succeeds', async () => {
  const run = await runner.runCheckpoint(plan({ env: {} }), { dispatch: queued, approvalMode: 'automatic' });
  assert.ok(run.report.gatedFollowThrough > 0);
  assert.ok(run.report.notes.some((n) => /will not leave until a human opens a gate/.test(n)));
});

test('an unexpected dispatcher status is treated as a failure, not assumed fine', async () => {
  const run = await runner.runCheckpoint(plan(), {
    dispatch: async () => ({ status: 'probably-ok' }),
    approvalMode: 'automatic',
  });
  assert.equal(run.report.failed, run.outcomes.length);
  assert.ok(run.outcomes.every((o) => /Unexpected dispatcher status/.test(o.detail)));
});

test('the runner requires a real plan and a dispatch function', async () => {
  await assert.rejects(() => runner.runCheckpoint(null, { dispatch: queued }), TypeError);
  await assert.rejects(() => runner.runCheckpoint(plan(), {}), TypeError);
  await assert.rejects(() => runner.runCheckpoint(plan(), { dispatch: 'nope' }), TypeError);
});

test('a whole day runs every checkpoint in order', async () => {
  const plans = coordinator.planDay({ collectedByCheckpoint: { morning: 0, midday: 900, afternoon: 2200, evening: 3600 }, env: ALL_OPEN });
  const runs = await runner.runDay(plans, { dispatch: queued, approvalMode: 'automatic' });
  assert.deepEqual(runs.map((r) => r.checkpoint), ['morning', 'midday', 'afternoon', 'evening']);
  // The evening checkpoint met target, so it plans verification only.
  assert.ok(runs[3].outcomes.length < runs[0].outcomes.length);
});

test('a dispatched outcome carries the job id so the run is traceable', async () => {
  const run = await runner.runCheckpoint(plan(), { dispatch: queued, approvalMode: 'automatic' });
  for (const o of run.outcomes.filter((x) => x.status === 'dispatched')) {
    assert.match(o.detail, /Queued as ai:/);
  }
});

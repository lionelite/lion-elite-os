const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../lib/agents/coordinator');
const roles = require('../lib/agents/roles');
const { BLOCKED_ACTIONS } = require('../lib/action-catalog');

const ALL_OPEN = {
  OUTREACH_SEND_ENABLED: 'true',
  SMS_SEND_ENABLED: 'true',
  SOCIAL_PUBLISH_ENABLED: 'true',
  BLUESKY_OUTREACH_ENABLED: 'true',
  AD_DAILY_SPEND_CAP: '150',
};
const ALL_CLOSED = {};

test('the gap is measured against pace, not just total', () => {
  const morning = c.revenueGap({ collectedToday: 500, hour: 9 });
  const evening = c.revenueGap({ collectedToday: 500, hour: 19 });
  assert.equal(morning.gap, evening.gap, 'the gap itself is the same');
  assert.ok(evening.behindBy > morning.behindBy, '$500 at 7pm is much worse than at 9am');
});

test('target met is reported plainly and stops pushing volume', () => {
  const gap = c.revenueGap({ collectedToday: 3600 });
  assert.equal(gap.targetMet, true);
  assert.equal(gap.gap, 0);
  const plan = c.planCheckpoint('afternoon', { collectedToday: 3600, hour: 16, env: ALL_OPEN });
  const actions = plan.assignments.map((a) => a.action);
  assert.ok(!actions.includes('draft-outreach'), 'must not push more outreach after the number is hit');
  assert.ok(!actions.includes('discover-prospects'));
  assert.match(plan.summary, /target met/);
});

test('the stretch target is tracked separately from the target', () => {
  const gap = c.revenueGap({ collectedToday: 4000 });
  assert.equal(gap.targetMet, true);
  assert.equal(gap.stretchMet, false);
  assert.equal(c.revenueGap({ collectedToday: 5200 }).stretchMet, true);
});

test('behind pace prioritises revenue roles above support work', () => {
  const plan = c.planCheckpoint('afternoon', { collectedToday: 200, hour: 16, env: ALL_OPEN });
  assert.equal(plan.gap.behindPace, true);
  const revenueIndex = plan.assignments.findIndex((a) => a.roleId === 'sales');
  const supportIndex = plan.assignments.findIndex((a) => a.roleId === 'operations');
  assert.ok(revenueIndex < supportIndex, 'sales work must outrank operations when behind');
});

test('assignments are ordered by expected impact', () => {
  const plan = c.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_OPEN });
  for (let i = 1; i < plan.assignments.length; i += 1) {
    assert.ok(plan.assignments[i - 1].impact >= plan.assignments[i].impact, 'impact must be non-increasing');
  }
});

test('a closed gate blocks follow-through and names the exact remedy', () => {
  const plan = c.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_CLOSED });
  assert.ok(plan.gatesClosed.includes('OUTREACH_SEND_ENABLED'));
  const sales = plan.assignments.find((a) => a.roleId === 'sales');
  assert.ok(sales.blockedFollowThrough.length > 0);
  const gate = sales.blockedFollowThrough.find((g) => g.control === 'OUTREACH_SEND_ENABLED');
  assert.equal(gate.envVar, 'OUTREACH_SEND_ENABLED');
  assert.match(gate.remedy, /A human sets/);
  assert.match(gate.remedy, /Claude does not flip it/);
});

test('an open gate clears the block', () => {
  const plan = c.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_OPEN });
  assert.equal(plan.blockedFollowThrough, 0);
  assert.deepEqual(plan.gatesClosed, []);
});

test('the ad spend cap requires a real positive number, not a boolean', () => {
  assert.equal(c.controlEnabled('AD_SPEND_CAP', { AD_DAILY_SPEND_CAP: 'true' }), false);
  assert.equal(c.controlEnabled('AD_SPEND_CAP', { AD_DAILY_SPEND_CAP: '0' }), false);
  assert.equal(c.controlEnabled('AD_SPEND_CAP', { AD_DAILY_SPEND_CAP: '-5' }), false);
  assert.equal(c.controlEnabled('AD_SPEND_CAP', { AD_DAILY_SPEND_CAP: '150' }), true);
});

test('human approval is never satisfied by an env var', () => {
  assert.equal(c.controlEnabled('HUMAN_APPROVAL', { HUMAN_APPROVAL: 'true' }), false);
  assert.equal(c.controlEnabled('HUMAN_APPROVAL', ALL_OPEN), false);
});

test('a gate is only open on an explicit true', () => {
  for (const value of ['', 'false', '1', 'yes', 'TRUE ', undefined]) {
    const expected = false;
    assert.equal(c.controlEnabled('OUTREACH_SEND_ENABLED', { OUTREACH_SEND_ENABLED: value }), expected, `"${value}" must not open the gate`);
  }
  assert.equal(c.controlEnabled('OUTREACH_SEND_ENABLED', { OUTREACH_SEND_ENABLED: 'true' }), true);
});

test('compliance is assigned whenever customer-facing copy is in the plan', () => {
  const plan = c.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_OPEN });
  assert.ok(plan.assignments.some((a) => a.action === 'draft-outreach'), 'fixture must include copy work');
  assert.ok(plan.assignments.some((a) => a.roleId === 'research-compliance'),
    'copy in the plan must pull in the RUO veto');
});

test('compliance is not assigned when no copy is in play', () => {
  const plan = c.planCheckpoint('evening', { collectedToday: 4000, hour: 19, env: ALL_OPEN });
  assert.ok(!plan.assignments.some((a) => a.action === 'draft-outreach'));
  assert.ok(!plan.assignments.some((a) => a.roleId === 'research-compliance'));
});

test('a role cannot be assigned an action outside its registry entry', () => {
  assert.throws(() => c.assignmentFor('sales', 'generate-social-content', {}), /may not perform/);
  assert.throws(() => c.assignmentFor('operations', 'draft-outreach', {}), /may not perform/);
});

test('no assignment can ever name a blocked action', () => {
  for (const blocked of BLOCKED_ACTIONS) {
    for (const r of roles.ROLES) {
      assert.throws(() => c.assignmentFor(r.id, blocked, {}), /may not perform/, `${r.id} + ${blocked}`);
    }
  }
});

test('an unknown role or checkpoint is refused', () => {
  assert.throws(() => c.assignmentFor('nope', 'morning-brief', {}), /Unknown role/);
  assert.throws(() => c.planCheckpoint('teatime', {}), /Unknown checkpoint/);
});

test('every assignment routes to a real queue and job', () => {
  const plan = c.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_OPEN });
  for (const a of plan.assignments) {
    assert.ok(a.queue, `${a.action} has no queue`);
    assert.ok(a.job, `${a.action} has no job`);
  }
});

test('a full day covers all four checkpoints in order', () => {
  const day = c.planDay({ collectedByCheckpoint: { morning: 0, midday: 800, afternoon: 2100, evening: 3600 }, env: ALL_OPEN });
  assert.deepEqual(day.map((p) => p.checkpoint), ['morning', 'midday', 'afternoon', 'evening']);
  assert.equal(day[3].gap.targetMet, true);
  assert.equal(day[0].gap.targetMet, false);
});

test('outcomes must be a known status', () => {
  const plan = c.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_OPEN });
  assert.throws(() => c.recordOutcome(plan.assignments[0], { outcome: 'probably fine' }), /Unknown assignment outcome/);
  assert.doesNotThrow(() => c.recordOutcome(plan.assignments[0], { outcome: 'completed' }));
});

test('a day where everything was blocked says so plainly instead of claiming progress', () => {
  const plan = c.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_CLOSED });
  const blocked = plan.assignments
    .filter((a) => a.blockedFollowThrough.length > 0)
    .map((a) => c.recordOutcome(a, { outcome: 'blocked' }));
  const report = c.dayReport(blocked);
  assert.match(report.verdict, /Every assignment was blocked/);
  assert.match(report.verdict, /a human has to open a gate/);
  assert.equal(report.revenueAttributed, 0);
  assert.ok(report.blockedControls.length > 0);
});

test('an empty day is reported as the loop not running, not as success', () => {
  assert.match(c.dayReport([]).verdict, /did not run/);
});

test('the day report sums only genuinely attributed revenue', () => {
  const plan = c.planCheckpoint('morning', { collectedToday: 0, hour: 9, env: ALL_OPEN });
  const outcomes = [
    c.recordOutcome(plan.assignments[0], { outcome: 'completed', revenueAttributed: 1200 }),
    c.recordOutcome(plan.assignments[1], { outcome: 'completed', revenueAttributed: 800 }),
    c.recordOutcome(plan.assignments[2], { outcome: 'failed', revenueAttributed: 0 }),
  ];
  const report = c.dayReport(outcomes);
  assert.equal(report.revenueAttributed, 2000);
  assert.equal(report.byStatus.completed, 2);
  assert.equal(report.byStatus.failed, 1);
  assert.equal(report.attainmentPct, 57.1);
});

test('the executive checkpoint job always runs, even when behind', () => {
  for (const checkpoint of roles.CHECKPOINTS) {
    const plan = c.planCheckpoint(checkpoint.id, { collectedToday: 0, hour: 9, env: ALL_CLOSED });
    const exec = plan.assignments.find((a) => a.roleId === 'executive');
    assert.ok(exec, `${checkpoint.id} must still refresh the numbers`);
    assert.equal(exec.action, checkpoint.action);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { newChecklist, record, evaluateMilestone, evaluateEngagement, BLOCKING_ITEMS } = require('../src/qc');

const MILESTONE = {
  id: 'follow-up',
  developerPayout: 1700,
  acceptanceTests: [
    { id: 'follow-up-at-1', statement: 'Sequence runs on schedule.' },
    { id: 'follow-up-at-2', statement: 'Tests pass in CI.' },
  ],
};

function passAll(milestone = MILESTONE) {
  const c = newChecklist(milestone.id);
  for (const item of BLOCKING_ITEMS) {
    if (item.id === 'acceptance-tests') continue;
    record(c, item.id, true);
  }
  c.reviewedBy = 'owner';
  const testResults = {};
  for (const t of milestone.acceptanceTests) testResults[t.id] = true;
  return { checklist: c, testResults };
}

test('a fully passing milestone is accepted and releases payment', () => {
  const { checklist, testResults } = passAll();
  const r = evaluateMilestone(MILESTONE, checklist, testResults);
  assert.equal(r.accepted, true);
  assert.equal(r.releaseDeveloperPayment, true);
  assert.equal(r.developerPayout, 1700);
  assert.deepEqual(r.openItems, []);
});

test('an empty checklist accepts nothing — unrecorded is not passed', () => {
  const r = evaluateMilestone(MILESTONE, newChecklist('follow-up'), {});
  assert.equal(r.accepted, false);
  assert.equal(r.releaseDeveloperPayment, false);
  assert.equal(r.developerPayout, 0);
  assert.ok(r.openItems.length >= BLOCKING_ITEMS.length);
});

test('every single blocking item can hold the milestone on its own', () => {
  for (const item of BLOCKING_ITEMS) {
    if (item.id === 'acceptance-tests') continue;
    const { checklist, testResults } = passAll();
    checklist.results[item.id] = { passed: false, note: null, at: new Date().toISOString() };
    const r = evaluateMilestone(MILESTONE, checklist, testResults);
    assert.equal(r.accepted, false, `${item.id} must be able to block`);
    assert.equal(r.developerPayout, 0);
  }
});

test('an unpassed acceptance test blocks acceptance', () => {
  const { checklist, testResults } = passAll();
  testResults['follow-up-at-2'] = false;
  const r = evaluateMilestone(MILESTONE, checklist, testResults);
  assert.equal(r.accepted, false);
  assert.ok(r.openItems.some((i) => i.kind === 'acceptance-test'));
});

test('an unrecorded acceptance test blocks acceptance', () => {
  const { checklist } = passAll();
  const r = evaluateMilestone(MILESTONE, checklist, { 'follow-up-at-1': true });
  assert.equal(r.accepted, false);
});

test('the acceptance-tests checklist item cannot be self-ticked past a failing test', () => {
  const { checklist } = passAll();
  record(checklist, 'acceptance-tests', true);
  const r = evaluateMilestone(MILESTONE, checklist, {});
  assert.equal(r.accepted, false);
  assert.ok(r.openItems.some((i) => i.id === 'acceptance-tests' && i.derived === true));
});

test('a checklist with no named reviewer is not accepted', () => {
  const { checklist, testResults } = passAll();
  checklist.reviewedBy = null;
  const r = evaluateMilestone(MILESTONE, checklist, testResults);
  assert.equal(r.accepted, false);
  assert.ok(r.openItems.some((i) => i.id === 'reviewer-named'));
});

test('advisory items do not hold payment', () => {
  const { checklist, testResults } = passAll();
  const r = evaluateMilestone(MILESTONE, checklist, testResults);
  assert.equal(r.accepted, true);
  assert.ok(r.advisoryOpen.length > 0, 'advisory items are open but not blocking');
});

test('a result must be an explicit boolean', () => {
  const c = newChecklist('follow-up');
  assert.throws(() => record(c, 'code-review', undefined), TypeError);
  assert.throws(() => record(c, 'code-review', 'yes'), TypeError);
});

test('an unknown checklist item is rejected', () => {
  assert.throws(() => record(newChecklist('x'), 'looks-fine-to-me', true), /Unknown QC item/);
});

test('only the final milestone invoices the client balance', () => {
  const { checklist, testResults } = passAll();
  assert.equal(evaluateMilestone(MILESTONE, checklist, testResults).invoiceClientBalance, false);
  const final = { ...MILESTONE, id: 'launch-hardening', triggersClientBalance: true };
  const p = passAll(final);
  assert.equal(evaluateMilestone(final, p.checklist, p.testResults).invoiceClientBalance, true);
});

test('secrets in the diff block acceptance', () => {
  const { checklist, testResults } = passAll();
  record(checklist, 'no-secrets-committed', false, 'API key found in a test fixture');
  assert.equal(evaluateMilestone(MILESTONE, checklist, testResults).accepted, false);
});

test('contractor contact with the client outside our channel blocks acceptance', () => {
  const { checklist, testResults } = passAll();
  record(checklist, 'no-contractor-client-contact', false, 'emailed the client directly');
  assert.equal(evaluateMilestone(MILESTONE, checklist, testResults).accepted, false);
});

test('the engagement is complete only when every milestone is accepted', () => {
  const milestones = [{ id: 'a' }, { id: 'b' }];
  const partial = evaluateEngagement(milestones, [{ milestoneId: 'a', accepted: true }]);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.outstandingMilestones, ['b']);
  const full = evaluateEngagement(milestones, [{ milestoneId: 'a', accepted: true }, { milestoneId: 'b', accepted: true }]);
  assert.equal(full.complete, true);
  assert.equal(full.acceptedCount, 2);
});

test('evaluating without a milestone throws', () => {
  assert.throws(() => evaluateMilestone(null, newChecklist('x'), {}), TypeError);
});

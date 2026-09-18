const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planEngagement } = require('../src/engagement');
const qc = require('../src/qc');
const L = require('../src/ledger');
const { summarize, estimateAccuracy, renderReport } = require('../src/portfolio');

const EXAMPLES = path.join(__dirname, '..', 'examples');
function example(name) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8'));
}
const CEDAR = planEngagement(example('cedar-roofing'));

function passAll(milestone) {
  const c = qc.newChecklist(milestone.id);
  for (const item of qc.BLOCKING_ITEMS) {
    if (item.id === 'acceptance-tests') continue;
    qc.record(c, item.id, true);
  }
  c.reviewedBy = 'owner';
  const results = {};
  for (const t of milestone.acceptanceTests) results[t.id] = true;
  return qc.evaluateMilestone(milestone, c, results);
}

function ledgerAt(state, { overrun = 0, engagement = CEDAR } = {}) {
  const l = L.openLedger(engagement);
  if (state === 'qualified') return l;
  L.recordProposalSent(l);
  if (state === 'proposed') return l;
  if (state === 'lost') { L.transition(l, 'lost'); return l; }
  L.recordReceipt(l, { amount: engagement.economics.depositAmount, kind: 'deposit' });
  L.transition(l, 'won');
  if (state === 'won') return l;
  L.transition(l, 'in_delivery');
  if (state === 'in_delivery') return l;
  for (const m of engagement.deliveryPlan.milestones) {
    L.acceptMilestone(l, passAll(m));
    if (m.developerPayout > 0) {
      L.releasePayment(l, { milestoneId: m.id, amount: m.developerPayout + (m.id === 'follow-up' ? overrun : 0) });
    }
    if (m.triggersClientBalance) L.recordReceipt(l, { amount: engagement.economics.balanceAmount, kind: 'balance' });
  }
  L.recordOpsSpend(l, { amount: engagement.economics.opsCost, description: 'hosting' });
  L.transition(l, 'delivered');
  if (state === 'delivered') return l;
  L.transition(l, 'closed');
  return l;
}

test('an empty portfolio summarises without throwing', () => {
  const s = summarize([]);
  assert.equal(s.engagements, 0);
  assert.equal(s.pipeline.weightedPipeline, 0);
  assert.equal(s.conversion.winRatePct, null);
  assert.match(renderReport([]), /No engagements on record yet/);
});

test('unsigned work is weighted, not counted at face value', () => {
  const s = summarize([ledgerAt('qualified'), ledgerAt('proposed')]);
  const price = CEDAR.economics.projectPrice;
  assert.equal(s.pipeline.grossPipeline, price * 2);
  // 10% qualified + 30% proposed
  assert.equal(s.pipeline.weightedPipeline, price * 0.1 + price * 0.3);
  assert.ok(s.pipeline.weightedPipeline < s.pipeline.grossPipeline);
});

test('signed work is contracted value, never double-counted in pipeline', () => {
  const s = summarize([ledgerAt('won')]);
  assert.equal(s.pipeline.grossPipeline, 0);
  assert.equal(s.pipeline.weightedPipeline, 0);
  assert.equal(s.pipeline.contractedValue, CEDAR.economics.projectPrice);
});

test('a lost deal contributes nothing to pipeline or contracted value', () => {
  const s = summarize([ledgerAt('lost')]);
  assert.equal(s.pipeline.grossPipeline, 0);
  assert.equal(s.pipeline.contractedValue, 0);
});

test('a disqualified prospect does not drag down the win rate', () => {
  const disqualified = L.openLedger(planEngagement(example('corner-cafe')));
  const withOut = summarize([ledgerAt('closed')]);
  const withIn = summarize([ledgerAt('closed'), disqualified]);
  assert.equal(withOut.conversion.winRatePct, 100);
  assert.equal(withIn.conversion.winRatePct, 100, 'a prospect we refused was never winnable');
  assert.equal(withIn.engagements, 2);
});

test('a lost deal does count against the win rate', () => {
  const s = summarize([ledgerAt('closed'), ledgerAt('lost')]);
  assert.equal(s.conversion.decided, 2);
  assert.equal(s.conversion.winRatePct, 50);
});

test('an open proposal is not counted as a loss', () => {
  const s = summarize([ledgerAt('closed'), ledgerAt('proposed')]);
  assert.equal(s.conversion.decided, 1);
  assert.equal(s.conversion.winRatePct, 100);
});

test('cash reconciles to collected minus paid out minus operating', () => {
  const s = summarize([ledgerAt('closed', { overrun: 250 }), ledgerAt('won')]);
  assert.equal(s.cash.cashHeld, s.cash.collected - s.cash.paidOut - s.cash.opsSpent);
});

test('contractor commitments include a delivered build with an unpaid milestone', () => {
  const l = ledgerAt('in_delivery');
  const s = summarize([l]);
  // Nothing paid yet, so the whole delivery budget is still committed.
  assert.equal(s.cash.committedToContractors, CEDAR.economics.developerCost);
  assert.equal(s.cash.coversCommitments, s.cash.cashHeld >= CEDAR.economics.developerCost);
});

test('a fully paid closed engagement commits nothing further', () => {
  const s = summarize([ledgerAt('closed')]);
  assert.equal(s.cash.committedToContractors, 0);
  assert.equal(s.cash.coversCommitments, true);
});

test('a deposit too small to cover commitments is flagged', () => {
  const l = ledgerAt('in_delivery');
  // Simulate having spent the deposit elsewhere.
  L.recordOpsSpend(l, { amount: CEDAR.economics.depositAmount });
  const s = summarize([l]);
  assert.equal(s.cash.coversCommitments, false);
  assert.ok(s.cash.uncommittedCash < 0);
  assert.match(renderReport([l]), /does NOT cover outstanding contractor commitments/);
});

test('a negative cash position is raised as high severity', () => {
  const l = ledgerAt('in_delivery');
  L.recordOpsSpend(l, { amount: CEDAR.economics.depositAmount + 1000 });
  const s = summarize([l]);
  assert.ok(s.attention.some((a) => a.severity === 'high' && /negative/.test(a.issue)));
});

test('an accepted but unpaid contractor milestone is raised', () => {
  const l = ledgerAt('in_delivery');
  L.acceptMilestone(l, passAll(CEDAR.deliveryPlan.milestones[1]));
  const s = summarize([l]);
  assert.ok(s.attention.some((a) => /Accepted but unpaid/.test(a.issue)));
});

test('our own zero-payout milestone is never raised as unpaid', () => {
  const l = ledgerAt('in_delivery');
  const discovery = CEDAR.deliveryPlan.milestones.find((m) => m.developerPayout === 0);
  L.acceptMilestone(l, passAll(discovery));
  const s = summarize([l]);
  assert.ok(!s.attention.some((a) => /Accepted but unpaid/.test(a.issue)));
});

test('a stale proposal is raised after two weeks', () => {
  const l = L.openLedger(CEDAR);
  L.recordProposalSent(l, { at: new Date(Date.now() - 20 * 86400000) });
  assert.ok(summarize([l]).attention.some((a) => /Proposal out 20 days/.test(a.issue)));

  const fresh = L.openLedger(CEDAR);
  L.recordProposalSent(fresh, { at: new Date(Date.now() - 3 * 86400000) });
  assert.ok(!summarize([fresh]).attention.some((a) => /Proposal out/.test(a.issue)));
});

test('attention items are ordered most severe first', () => {
  const broke = ledgerAt('in_delivery');
  L.recordOpsSpend(broke, { amount: CEDAR.economics.depositAmount + 500 });
  L.acceptMilestone(broke, passAll(CEDAR.deliveryPlan.milestones[1]));
  const order = summarize([broke]).attention.map((a) => a.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a] - { high: 0, medium: 1, low: 2 }[b])));
});

test('retainer contracted and collected are reported separately', () => {
  const l = ledgerAt('closed');
  const s = summarize([l]);
  assert.equal(s.recurring.contractedMonthly, CEDAR.economics.monthlyRetainer);
  assert.equal(s.recurring.collected, 0);
  assert.match(renderReport([l]), /A retainer nobody bills is not revenue/);

  L.recordReceipt(l, { amount: 2000, kind: 'retainer' });
  assert.equal(summarize([l]).recurring.collected, 2000);
});

test('estimate accuracy says so plainly when there is no sample', () => {
  const a = estimateAccuracy([]);
  assert.equal(a.sample, 0);
  assert.match(a.verdict, /unvalidated/);
});

test('a consistent overrun tells us to raise the planning numbers', () => {
  const a = estimateAccuracy([
    { clientRef: 'a', developerCost: 1500, plannedDeveloperCost: 7500 },
    { clientRef: 'b', developerCost: 1600, plannedDeveloperCost: 8000 },
  ]);
  assert.ok(a.meanVariancePct > 5);
  assert.match(a.verdict, /Raise DEVELOPER_COST_PER_CAPABILITY/);
  assert.match(a.verdict, /underpriced/);
});

test('coming in under estimate is reported as a chance to win more deals', () => {
  const a = estimateAccuracy([{ clientRef: 'a', developerCost: -1500, plannedDeveloperCost: 7500 }]);
  assert.ok(a.meanVariancePct < -5);
  assert.match(a.verdict, /conservative/);
});

test('estimates within five percent are left alone', () => {
  const a = estimateAccuracy([{ clientRef: 'a', developerCost: 100, plannedDeveloperCost: 7700 }]);
  assert.match(a.verdict, /holding/);
});

test('a closed engagement feeds its real variance into estimate accuracy', () => {
  const s = summarize([ledgerAt('closed', { overrun: 250 })]);
  assert.equal(s.estimateAccuracy.sample, 1);
  assert.equal(s.estimateAccuracy.detail[0].developerCost, 250);
  assert.equal(s.estimateAccuracy.detail[0].actualDeveloperCost, CEDAR.economics.developerCost + 250);
});

test('the report is marked internal and carries cost and margin', () => {
  const md = renderReport([ledgerAt('closed', { overrun: 250 })]);
  assert.match(md, /INTERNAL/);
  assert.match(md, /## Cash/);
  assert.match(md, /Paid to contractors/);
  assert.match(md, /## Estimate accuracy/);
});

test('mixed states all appear in the state breakdown', () => {
  const s = summarize([ledgerAt('qualified'), ledgerAt('proposed'), ledgerAt('won'), ledgerAt('closed'), ledgerAt('lost')]);
  assert.equal(s.engagements, 5);
  assert.deepEqual(Object.keys(s.byState).sort(), ['closed', 'lost', 'proposed', 'qualified', 'won']);
});

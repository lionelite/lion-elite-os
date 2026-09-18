const test = require('node:test');
const assert = require('node:assert/strict');
const {
  priceFromValue, recommendRetainer, quotePricing, checkCashFlow,
  MARGIN_FLOOR, DEV_COST_CAP_RATIO, DEPOSIT_FLOOR, PRODUCTIZED_CEILING, PRICE_FLOOR,
} = require('../src/pricing');

const OPPORTUNITY = { annualRecoverableValue: 116430 };

test('the reference deal clears every gate', () => {
  const q = quotePricing({
    projectPrice: 20000, developerCost: 7000, opsCost: 1500,
    depositRate: 0.6, monthlyRetainer: 2500, opportunity: { annualRecoverableValue: 200000 },
  });
  assert.equal(q.approved, true);
  assert.equal(q.grossProfit, 11500);
  assert.ok(q.grossMargin >= MARGIN_FLOOR);
  assert.equal(q.depositAmount, 12000);
  assert.equal(q.balanceAmount, 8000);
});

test('price is derived from client value, not from our cost', () => {
  const cheap = priceFromValue(OPPORTUNITY, { estimatedDeveloperCost: 3000, estimatedOpsCost: 500 });
  const dear = priceFromValue(OPPORTUNITY, { estimatedDeveloperCost: 7000, estimatedOpsCost: 1500 });
  // Same client value → the value-based component is identical regardless of cost.
  assert.equal(cheap.valueBasedPrice, dear.valueBasedPrice);
  assert.ok(cheap.recommendedPrice >= PRICE_FLOOR);
});

test('a high delivery estimate raises the price so the cost cap is satisfied', () => {
  const p = priceFromValue({ annualRecoverableValue: 90858 }, { estimatedDeveloperCost: 8850, estimatedOpsCost: 1600 });
  assert.ok(p.recommendedPrice >= p.devCapFloor, 'price must clear the developer-cost cap floor');
  const q = quotePricing({
    projectPrice: p.recommendedPrice, developerCost: 8850, opsCost: 1600,
    depositRate: 0.6, monthlyRetainer: 0, opportunity: { annualRecoverableValue: 90858 },
  });
  assert.ok(!q.blockers.some((b) => /exceeds 40%/.test(b)), 'the dev-cost cap must not be breached');
});

test('rounding never drops the quote below its own floor', () => {
  for (const dev of [5000, 6200, 7350, 8850, 10400]) {
    const p = priceFromValue({ annualRecoverableValue: 400000 }, { estimatedDeveloperCost: dev, estimatedOpsCost: 1600 });
    assert.ok(p.recommendedPrice >= p.priceFloor, `dev ${dev}: ${p.recommendedPrice} < floor ${p.priceFloor}`);
  }
});

test('an enormous value is clamped to the productized ceiling and escalated', () => {
  const p = priceFromValue({ annualRecoverableValue: 2000000 }, { estimatedDeveloperCost: 8000, estimatedOpsCost: 1600 });
  assert.equal(p.recommendedPrice, PRODUCTIZED_CEILING);
  assert.equal(p.escalateToCustom, true);
  assert.match(p.escalationNote, /owner decision/i);
});

test('price never exceeds a third of year-one value', () => {
  const p = priceFromValue({ annualRecoverableValue: 60000 }, { estimatedDeveloperCost: 4000, estimatedOpsCost: 1000 });
  assert.ok(p.recommendedPrice <= p.valueCeiling || p.priceFloor > p.valueCeiling);
});

test('a build too expensive for the client is flagged infeasible', () => {
  const p = priceFromValue({ annualRecoverableValue: 40000 }, { estimatedDeveloperCost: 20000, estimatedOpsCost: 4000 });
  assert.equal(p.infeasible, true);
});

test('a margin under the floor blocks the quote', () => {
  const q = quotePricing({ projectPrice: 20000, developerCost: 9000, opsCost: 3000, depositRate: 0.6 });
  assert.equal(q.approved, false);
  assert.ok(q.blockers.some((b) => /Gross margin/.test(b)));
});

test('developer cost over its cap blocks the quote', () => {
  const q = quotePricing({ projectPrice: 20000, developerCost: 9000, opsCost: 500, depositRate: 0.6 });
  assert.equal(q.approved, false);
  assert.ok(q.blockers.some((b) => new RegExp(`${DEV_COST_CAP_RATIO * 100}%`).test(b)));
});

test('a deposit under the floor blocks the quote', () => {
  const q = quotePricing({ projectPrice: 20000, developerCost: 7000, opsCost: 1500, depositRate: 0.25 });
  assert.equal(q.approved, false);
  assert.ok(q.blockers.some((b) => new RegExp(`${DEPOSIT_FLOOR * 100}%`).test(b)));
});

test('a price below the engagement floor blocks the quote', () => {
  const q = quotePricing({ projectPrice: 5000, developerCost: 1000, opsCost: 200, depositRate: 0.6 });
  assert.equal(q.approved, false);
  assert.ok(q.blockers.some((b) => /engagement floor/.test(b)));
});

test('a missing retainer warns rather than blocking', () => {
  const q = quotePricing({ projectPrice: 20000, developerCost: 7000, opsCost: 1500, depositRate: 0.6, opportunity: { annualRecoverableValue: 200000 } });
  assert.equal(q.approved, true);
  assert.ok(q.warnings.some((w) => /management retainer/.test(w)));
});

test('a margin between floor and target warns but proceeds', () => {
  const q = quotePricing({ projectPrice: 20000, developerCost: 8000, opsCost: 1500, depositRate: 0.6, monthlyRetainer: 2000, opportunity: { annualRecoverableValue: 300000 } });
  assert.equal(q.approved, true);
  assert.ok(q.warnings.some((w) => /under the 60% target/.test(w)));
});

test('a zero price is rejected', () => {
  assert.equal(quotePricing({ projectPrice: 0, developerCost: 0 }).approved, false);
});

test('the retainer stays inside its band', () => {
  assert.equal(recommendRetainer({ annualRecoverableValue: 50000 }).monthlyRetainer, 2000);
  assert.equal(recommendRetainer({ annualRecoverableValue: 10000000 }).monthlyRetainer, 5000);
  const mid = recommendRetainer({ annualRecoverableValue: 400000 });
  assert.ok(mid.monthlyRetainer > 2000 && mid.monthlyRetainer < 5000);
});

test('cash flow stays solvent when the deposit covers payouts before the balance', () => {
  const flow = checkCashFlow({
    depositAmount: 12600, balanceAmount: 8400,
    milestones: [
      { id: 'a', developerPayout: 1550 },
      { id: 'b', developerPayout: 1700 },
      { id: 'c', developerPayout: 775, triggersClientBalance: true },
    ],
  });
  assert.equal(flow.solvent, true);
  assert.ok(flow.lowestBalance >= 0);
  assert.equal(flow.warning, null);
});

test('cash flow catches a schedule that goes negative before the balance lands', () => {
  const flow = checkCashFlow({
    depositAmount: 2000, balanceAmount: 18000,
    milestones: [
      { id: 'a', developerPayout: 4000 },
      { id: 'b', developerPayout: 3000, triggersClientBalance: true },
    ],
  });
  assert.equal(flow.solvent, false);
  assert.ok(flow.lowestBalance < 0);
  assert.match(flow.warning, /Raise the deposit/);
});

test('the cash ledger reconciles to deposit + balance - payouts', () => {
  const flow = checkCashFlow({
    depositAmount: 12600, balanceAmount: 8400,
    milestones: [{ id: 'a', developerPayout: 5000 }, { id: 'b', developerPayout: 2700, triggersClientBalance: true }],
  });
  assert.equal(flow.finalBalance, 12600 + 8400 - 7700);
});

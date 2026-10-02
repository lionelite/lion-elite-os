const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planEngagement, estimateCosts } = require('../src/engagement');
const { resolveCapabilities } = require('../src/offer');
const { MARGIN_FLOOR, DEV_COST_CAP_RATIO, DEPOSIT_FLOOR } = require('../src/pricing');

const EXAMPLES = path.join(__dirname, '..', 'examples');
function example(name) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, name), 'utf8'));
}

test('the reference client lands on the reference deal shape', () => {
  const e = planEngagement(example('cedar-roofing.json'));
  assert.equal(e.proceed, true);
  assert.equal(e.stage, 'ready-to-propose');
  const ec = e.economics;
  // The model in the owner's brief: ~$20k price, $5–8k delivery, $1–2k operating,
  // ~$10–14k gross profit, $2–5k/mo retainer.
  assert.ok(ec.projectPrice >= 15000 && ec.projectPrice <= 30000, `price ${ec.projectPrice}`);
  assert.ok(ec.developerCost >= 5000 && ec.developerCost <= 8000, `delivery ${ec.developerCost}`);
  assert.ok(ec.opsCost >= 1000 && ec.opsCost <= 2000, `operating ${ec.opsCost}`);
  assert.ok(ec.grossProfit >= 10000 && ec.grossProfit <= 14000, `profit ${ec.grossProfit}`);
  assert.ok(ec.monthlyRetainer >= 2000 && ec.monthlyRetainer <= 5000, `retainer ${ec.monthlyRetainer}`);
});

test('every example plans without throwing and reports a coherent stage', () => {
  for (const file of fs.readdirSync(EXAMPLES)) {
    const e = planEngagement(example(file));
    assert.ok(['ready-to-propose', 'discovery-incomplete', 'blocked', 'disqualified'].includes(e.stage), file);
    if (e.proceed) assert.equal(e.stage, 'ready-to-propose', file);
  }
});

test('a disqualified prospect gets no price and no delivery plan', () => {
  const e = planEngagement(example('corner-cafe.json'));
  assert.equal(e.proceed, false);
  assert.equal(e.stage, 'disqualified');
  assert.equal(e.economics, undefined);
  assert.equal(e.deliveryPlan, undefined);
  assert.ok(e.blockers.length > 0);
});

test('every approved engagement clears the margin, cost-cap and deposit gates', () => {
  for (const file of fs.readdirSync(EXAMPLES)) {
    const e = planEngagement(example(file));
    if (!e.proceed) continue;
    assert.ok(e.quote.grossMargin >= MARGIN_FLOOR, `${file} margin`);
    assert.ok(e.economics.developerCost <= e.economics.projectPrice * DEV_COST_CAP_RATIO, `${file} dev cap`);
    assert.ok(e.quote.depositRate >= DEPOSIT_FLOOR, `${file} deposit`);
    assert.equal(e.cashFlow.solvent, true, `${file} cash flow`);
  }
});

test('the developer budget always equals what the milestones allocate', () => {
  for (const file of fs.readdirSync(EXAMPLES)) {
    const e = planEngagement(example(file));
    if (!e.deliveryPlan) continue;
    assert.equal(e.deliveryPlan.allocatedToMilestones, e.economics.developerCost, file);
  }
});

test('a high-value client is quoted at the ceiling and escalated to the owner', () => {
  const e = planEngagement(example('summit-energy.json'));
  assert.equal(e.proceed, true);
  assert.equal(e.economics.projectPrice, 45000);
  assert.ok(e.escalations.some((x) => /productized ceiling/.test(x)));
});

test('a client too small for the standard retainer is restructured, not rejected', () => {
  const e = planEngagement(example('lakeside-dental.json'));
  assert.equal(e.proceed, true);
  assert.equal(e.retainer.structure, 'quarterly-optimization');
  assert.equal(e.economics.monthlyRetainer, 0);
  assert.ok(e.retainer.quarterlyOptimization > 0);
  assert.ok(e.escalations.some((x) => /quarter optimization package/.test(x)));
});

test('a regulated engagement restricts contractor access and demands a BAA', () => {
  const e = planEngagement(example('lakeside-dental.json'));
  assert.ok(e.access.complianceFlags.includes('PHI'));
  assert.ok(e.access.requiredAgreements.includes('baa'));
  assert.deepEqual(e.access.tiersInUse, ['sandbox']);
  assert.ok(e.access.downgradedTickets.length > 0);
});

test('incomplete discovery blocks the quote without disqualifying the prospect', () => {
  const client = example('cedar-roofing.json');
  delete client.currentCloseRate;
  const e = planEngagement(client);
  assert.equal(e.proceed, false);
  assert.equal(e.stage, 'discovery-incomplete');
  assert.match(e.recommendation, /Do not quote yet/);
});

test('cost multipliers raise the delivery estimate for genuinely harder builds', () => {
  const caps = resolveCapabilities(null);
  const plain = estimateCosts(caps, {});
  const legacy = estimateCosts(caps, { legacySystemWithoutApi: true });
  const manyChannels = estimateCosts(caps, { channelCount: 6 });
  const regulated = estimateCosts(caps, { verticalId: 'private-medical' });
  assert.ok(legacy.developerCost > plain.developerCost);
  assert.ok(manyChannels.developerCost > plain.developerCost);
  assert.ok(regulated.developerCost > plain.developerCost);
  assert.ok(regulated.multipliers.some((m) => /Regulated data/.test(m)));
});

test('dropping the optional capability lowers both cost and operating spend', () => {
  const full = estimateCosts(resolveCapabilities(null), {});
  const lean = estimateCosts(resolveCapabilities(['lead-capture', 'follow-up', 'qualification', 'reporting']), {});
  assert.ok(lean.developerCost < full.developerCost);
  assert.ok(lean.opsCost < full.opsCost);
});

test('a client reference is required — tickets are namespaced by it', () => {
  assert.throws(() => planEngagement({ name: 'No Ref' }), TypeError);
  assert.throws(() => planEngagement(null), TypeError);
});

test('the engagement carries the offer statement so a proposal cannot drift off-offer', () => {
  const e = planEngagement(example('cedar-roofing.json'));
  assert.match(e.offerStatement, /recover missed leads/);
  assert.equal(e.offerId, 'missed-revenue-recovery');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeliveryPlan, allocate, MILESTONE_WEIGHTS } = require('../src/delivery-plan');

function plan(overrides = {}) {
  return buildDeliveryPlan({ clientRef: 'acme', developerBudget: 7700, ...overrides });
}

test('an allocation always sums exactly to the budget', () => {
  for (const budget of [7700, 8300, 10400, 5133, 6666.67]) {
    const parts = allocate(budget, [{ weight: 20 }, { weight: 22 }, { weight: 18 }, { weight: 12 }, { weight: 18 }, { weight: 10 }]);
    const total = parts.reduce((a, b) => a + b, 0);
    assert.equal(Math.round(total * 100) / 100, Math.round(budget * 100) / 100, `budget ${budget}`);
  }
});

test('milestone payouts sum exactly to the developer budget', () => {
  const p = plan();
  assert.equal(p.allocatedToMilestones, p.developerBudget);
});

test('ticket prices sum exactly to their milestone payout', () => {
  const p = plan();
  for (const m of p.milestones) {
    if (!m.tickets.length) continue;
    const total = m.tickets.reduce((s, t) => s + t.fixedPrice, 0);
    assert.equal(Math.round(total * 100) / 100, Math.round(m.developerPayout * 100) / 100, m.id);
  }
});

test('every milestone has at least one acceptance test', () => {
  for (const m of plan().milestones) assert.ok(m.acceptanceTests.length >= 1, m.id);
});

test('every ticket has acceptance criteria, a fixed price and an access tier', () => {
  for (const t of plan().tickets) {
    assert.ok(t.acceptanceCriteria.length >= 1, `${t.id} criteria`);
    assert.ok(t.fixedPrice > 0, `${t.id} price`);
    assert.ok(t.accessTier, `${t.id} tier`);
    assert.ok(t.accessPlan, `${t.id} access plan`);
  }
});

test('no ticket or milestone is billed hourly', () => {
  const p = plan();
  for (const m of p.milestones) assert.equal(m.billing, 'fixed-price-on-acceptance');
  for (const t of p.tickets) assert.equal(t.billing, 'fixed-price-on-acceptance');
});

test('discovery and architecture is ours and carries no contractor payout', () => {
  const discovery = plan().milestones.find((m) => m.id === 'discovery-architecture');
  assert.equal(discovery.ownedBy, 'agency');
  assert.equal(discovery.developerPayout, 0);
  assert.equal(discovery.tickets.length, 0);
  assert.equal(MILESTONE_WEIGHTS['discovery-architecture'], 0);
});

test('exactly one milestone triggers the client balance, and it is the last', () => {
  const ms = plan().milestones;
  const triggers = ms.filter((m) => m.triggersClientBalance);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].id, ms[ms.length - 1].id);
});

test('ticket ids are namespaced by client so two engagements never collide', () => {
  const a = buildDeliveryPlan({ clientRef: 'acme', developerBudget: 7700 });
  const b = buildDeliveryPlan({ clientRef: 'beta', developerBudget: 7700 });
  const overlap = a.tickets.map((t) => t.id).filter((id) => b.tickets.some((t) => t.id === id));
    assert.deepEqual(overlap, []);
  for (const t of a.tickets) assert.match(t.id, /^acme-/);
});

test('dropping an optional capability drops its milestone and reallocates the budget', () => {
  const full = plan();
  const lean = plan({ capabilities: ['lead-capture', 'follow-up', 'qualification', 'reporting'] });
  assert.ok(full.milestones.some((m) => m.id === 'scheduling'));
  assert.ok(!lean.milestones.some((m) => m.id === 'scheduling'));
  assert.equal(lean.allocatedToMilestones, lean.developerBudget);
});

test('a required capability cannot be dropped from the plan', () => {
  const p = plan({ capabilities: ['scheduling'] });
  for (const id of ['lead-capture', 'follow-up', 'qualification', 'reporting']) {
    assert.ok(p.milestones.some((m) => m.id === id), `${id} must survive`);
  }
});

test('compliance flags downgrade a staging ticket to sandbox', () => {
  const p = plan({ complianceFlags: ['PHI'] });
  const staged = p.tickets.filter((t) => t.accessTier === 'staging' || t.accessTier === 'integration-sandbox');
  assert.ok(staged.length > 0, 'fixture must contain a staging ticket to be meaningful');
  for (const t of staged) {
    assert.equal(t.accessPlan.effectiveTier, 'sandbox');
    assert.equal(t.accessPlan.downgraded, true);
  }
});

test('a plan cannot be built without a client reference', () => {
  assert.throws(() => buildDeliveryPlan({ developerBudget: 7700 }), TypeError);
});

test('a plan cannot be built without a positive budget', () => {
  assert.throws(() => buildDeliveryPlan({ clientRef: 'acme', developerBudget: 0 }), TypeError);
  assert.throws(() => buildDeliveryPlan({ clientRef: 'acme', developerBudget: -5 }), TypeError);
});

test('acceptance tests carry stable ids so results can be recorded against them', () => {
  const p = plan();
  const ids = p.milestones.flatMap((m) => m.acceptanceTests.map((t) => t.id));
  assert.equal(new Set(ids).size, ids.length, 'acceptance test ids must be unique');
  for (const id of ids) assert.match(id, /-at-\d+$/);
});

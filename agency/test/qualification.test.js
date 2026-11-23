const test = require('node:test');
const assert = require('node:assert/strict');
const { sizeOpportunity, qualifyClient, checkRoi, FLOORS, RECOVERED_CLOSE_DISCOUNT } = require('../src/qualification');

const SOLID = {
  ref: 'solid-co',
  verticalId: 'specialty-contractor',
  monthlyInboundLeads: 70,
  missedLeadRate: 0.3,
  currentCloseRate: 0.22,
  averageCustomerValue: 9000,
  manualFollowUpHoursWeekly: 10,
  loadedHourlyCost: 32,
  decisionMakerEngaged: true,
};

test('a recovered lead is modelled closing below the normal close rate', () => {
  const o = sizeOpportunity(SOLID);
  assert.equal(o.effectiveCloseRate, 0.22 * RECOVERED_CLOSE_DISCOUNT);
  assert.ok(RECOVERED_CLOSE_DISCOUNT < 1, 'the discount must actually discount');
});

test('percentages are accepted as either 0.3 or 30', () => {
  const asFraction = sizeOpportunity({ ...SOLID, missedLeadRate: 0.3 });
  const asPercent = sizeOpportunity({ ...SOLID, missedLeadRate: 30 });
  assert.equal(asFraction.annualRecoverableValue, asPercent.annualRecoverableValue);
});

test('value is the sum of revenue recovered and time returned', () => {
  const o = sizeOpportunity(SOLID);
  assert.equal(o.annualRecoverableValue, o.revenueGainedAnnual + o.costReducedAnnual);
});

test('assumptions travel with the number so a proposal can state them', () => {
  const o = sizeOpportunity(SOLID);
  assert.equal(o.assumptions.recoveryRate, 0.35);
  assert.equal(o.assumptions.recoveredCloseDiscount, RECOVERED_CLOSE_DISCOUNT);
  assert.ok(o.assumptions.note.length > 20);
});

test('a solid prospect qualifies', () => {
  const q = qualifyClient(SOLID);
  assert.equal(q.verdict, 'PURSUE');
  assert.deepEqual(q.blockers, []);
  assert.deepEqual(q.gaps, []);
});

test('a low customer value disqualifies no matter the lead volume', () => {
  const q = qualifyClient({ ...SOLID, monthlyInboundLeads: 5000, averageCustomerValue: 45 });
  assert.equal(q.verdict, 'DISQUALIFY');
  assert.ok(q.blockers.some((b) => /Average customer value/.test(b)));
});

test('thin lead volume disqualifies', () => {
  const q = qualifyClient({ ...SOLID, monthlyInboundLeads: 8 });
  assert.equal(q.verdict, 'DISQUALIFY');
  assert.ok(q.blockers.some((b) => /Inbound volume/.test(b)));
});

test('no engaged decision-maker disqualifies', () => {
  const q = qualifyClient({ ...SOLID, decisionMakerEngaged: false });
  assert.equal(q.verdict, 'DISQUALIFY');
  assert.ok(q.blockers.some((b) => /decision-maker/.test(b)));
});

test('a demand for hourly billing disqualifies', () => {
  const q = qualifyClient({ ...SOLID, wantsHourlyBilling: true });
  assert.equal(q.verdict, 'DISQUALIFY');
  assert.ok(q.blockers.some((b) => /hourly/i.test(b)));
});

test('a demand for a revenue guarantee disqualifies', () => {
  const q = qualifyClient({ ...SOLID, wantsRevenueGuarantee: true });
  assert.equal(q.verdict, 'DISQUALIFY');
});

test('missing facts produce DISCOVERY, not a quote', () => {
  const partial = { ...SOLID };
  delete partial.currentCloseRate;
  const q = qualifyClient(partial);
  assert.equal(q.verdict, 'DISCOVERY');
  assert.ok(q.gaps.some((g) => /currentCloseRate/.test(g)));
});

test('an unconfirmed decision-maker is a gap, not a blocker', () => {
  const partial = { ...SOLID };
  delete partial.decisionMakerEngaged;
  const q = qualifyClient(partial);
  assert.equal(q.verdict, 'DISCOVERY');
  assert.deepEqual(q.blockers, []);
});

test('a blocker beats a gap — never quote a disqualified prospect', () => {
  const partial = { ...SOLID, averageCustomerValue: 45 };
  delete partial.currentCloseRate;
  assert.equal(qualifyClient(partial).verdict, 'DISQUALIFY');
});

test('compliance flags propagate from the vertical', () => {
  const q = qualifyClient({ ...SOLID, verticalId: 'private-medical', averageCustomerValue: 3400 });
  assert.ok(q.complianceFlags.includes('PHI'));
  assert.ok(q.notes.some((n) => /contractor access/i.test(n)));
});

test('a customer value below the vertical norm is a note to re-check, not a decline', () => {
  const q = qualifyClient({ ...SOLID, verticalId: 'commercial-real-estate' });
  assert.ok(q.notes.some((n) => /per-job or per-customer-lifetime/.test(n)));
  assert.deepEqual(q.blockers, []);
});

test('a slow-payback price is blocked', () => {
  const o = sizeOpportunity(SOLID);
  const roi = checkRoi(o, { projectPrice: o.annualRecoverableValue, monthlyRetainer: 0 });
  assert.equal(roi.acceptable, false);
  assert.ok(roi.blockers.some((b) => /pays back/.test(b)));
});

test('a fast-payback price passes and reports the payback', () => {
  const o = sizeOpportunity(SOLID);
  const roi = checkRoi(o, { projectPrice: 21000, monthlyRetainer: 2000 });
  assert.equal(roi.acceptable, true);
  assert.ok(roi.paybackMonths < FLOORS.buildPaybackMonths);
});

test('an oversized retainer warns without blocking the deal', () => {
  const o = sizeOpportunity(SOLID);
  const roi = checkRoi(o, { projectPrice: 21000, monthlyRetainer: 5000 });
  assert.ok(roi.warnings.some((w) => /will not renew/.test(w)));
});

test('no value figure means the price cannot be defended', () => {
  const roi = checkRoi({ annualRecoverableValue: 0 }, { projectPrice: 20000 });
  assert.equal(roi.acceptable, false);
});

test('qualifyClient rejects a non-object', () => {
  assert.throws(() => qualifyClient(null), TypeError);
});

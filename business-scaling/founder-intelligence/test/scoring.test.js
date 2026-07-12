const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeFounder, budgetQualification } = require('../src/scoring');

test('qualifies a highly coachable and financially ready founder', () => {
  const result = analyzeFounder({
    coachability: 92,
    ownership: 90,
    execution: 88,
    businessFundamentals: 82,
    financialReadiness: 85,
    systemsMaturity: 78,
    commitment: 95,
    monthlyRevenue: 60000,
    monthlyProfit: 15000,
    availableCapital: 30000,
    desiredInvestment: 12000,
  });
  assert.equal(result.decision, 'ELITE_FIT');
  assert.equal(result.redFlags.length, 0);
  assert.equal(result.budget.canFund, true);
});

test('red flags override a high numerical score', () => {
  const result = analyzeFounder({
    coachability: 95,
    ownership: 95,
    execution: 95,
    businessFundamentals: 95,
    financialReadiness: 95,
    systemsMaturity: 95,
    commitment: 95,
    availableCapital: 50000,
    desiredInvestment: 10000,
    rejectsDirectFeedback: true,
  });
  assert.equal(result.decision, 'DECLINE');
  assert.ok(result.redFlags.includes('Resists direct feedback'));
});

test('budget qualification does not confuse revenue with affordability', () => {
  const result = budgetQualification({
    monthlyRevenue: 120000,
    monthlyProfit: -5000,
    availableCapital: 2000,
    desiredInvestment: 10000,
  });
  assert.equal(result.canFund, false);
  assert.equal(result.tier, 'FOUNDATION');
});

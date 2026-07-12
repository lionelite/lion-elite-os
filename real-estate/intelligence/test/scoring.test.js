const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeProperty, calculateEconomics, findDealKillers } = require('../src/scoring');

const baseProperty = {
  id: 'TEST-1',
  address: '100 Test Ave, Miami, FL',
  askingPrice: 800000,
  estimatedMarketValue: 950000,
  estimatedRepairs: 40000,
  monthlyGrossRent: 9000,
  annualOperatingExpenses: 36000,
  annualDebtService: 52000,
  positiveCashFlow: true,
  motivationScore: 80,
  equityScore: 75,
  physicalConditionScore: 80,
  legalRiskScore: 85,
  marketScore: 80,
  dataConfidenceScore: 80,
  sellerMotivationVerified: true,
  sellerAuthorityVerified: true,
  legalUnitCountVerified: true,
  rentRollVerified: true,
  generalInspectionComplete: true,
  roofInspectionComplete: true,
  electricalInspectionComplete: true,
  plumbingInspectionComplete: true,
  hvacInspectionComplete: true,
  wdoInspectionComplete: true,
  insuranceQuoteVerified: true,
  managementBudgetVerified: true,
  financingVerified: true,
  clearTitleExpected: true,
  insuranceAvailable: true,
};

test('calculates NOI, cap rate, DSCR and basis', () => {
  const result = calculateEconomics(baseProperty);
  assert.equal(result.metrics.grossRent, 108000);
  assert.equal(result.metrics.noi, 72000);
  assert.equal(result.metrics.allInBasis, 840000);
  assert.equal(result.metrics.dscr, 1.38);
});

test('recommends pursuing a strong verified deal', () => {
  const result = analyzeProperty(baseProperty);
  assert.equal(result.recommendation, 'PURSUE');
  assert.equal(result.dealKillers.length, 0);
  assert.equal(result.missingCriticalFacts.length, 0);
  assert.ok(result.score >= 75);
});

test('deal killer overrides an otherwise strong score', () => {
  const result = analyzeProperty({ ...baseProperty, legalUnitCountVerified: false });
  assert.equal(result.recommendation, 'PASS');
  assert.ok(result.dealKillers.includes('Illegal or unverified unit count'));
});

test('identifies multiple fatal risks', () => {
  const killers = findDealKillers({
    legalUnitCountVerified: false,
    insuranceAvailable: false,
    accessDeniedForInspection: true,
  });
  assert.equal(killers.length, 3);
});

test('lists incomplete due diligence with responsible professionals', () => {
  const result = analyzeProperty({ ...baseProperty, roofInspectionComplete: false });
  const roof = result.missingCriticalFacts.find((item) => item.task.includes('roof'));
  assert.equal(roof.owner, 'Licensed roofing contractor');
});

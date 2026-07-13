const { analyzeProperty } = require('./scoring');

const candidates = Array.from({ length: 5 }, (_, index) => ({
  id: `MIA-${index + 1}`,
  address: `Candidate ${index + 1}, Miami, FL`,
  askingPrice: 800000 + index * 75000,
  estimatedMarketValue: 900000 + index * 80000,
  estimatedRepairs: 50000 + index * 10000,
  monthlyGrossRent: 8500 + index * 600,
  annualOperatingExpenses: 36000 + index * 3500,
  annualDebtService: 52000 + index * 4500,
  positiveCashFlow: true,
  motivationScore: 55 + index * 7,
  equityScore: 60 + index * 5,
  physicalConditionScore: 75 - index * 4,
  legalRiskScore: 70,
  marketScore: 78,
  dataConfidenceScore: 45 + index * 8,
  sellerMotivationVerified: index > 1,
  sellerAuthorityVerified: true,
  legalUnitCountVerified: index !== 3,
  rentRollVerified: index > 0,
  generalInspectionComplete: false,
  roofInspectionComplete: false,
  electricalInspectionComplete: false,
  plumbingInspectionComplete: false,
  hvacInspectionComplete: false,
  wdoInspectionComplete: false,
  insuranceQuoteVerified: index === 4,
  managementBudgetVerified: index >= 3,
  financingVerified: false,
  clearTitleExpected: true,
  insuranceAvailable: true,
}));

const ranked = candidates
  .map((candidate) => analyzeProperty(candidate))
  .sort((a, b) => b.score - a.score);

console.table(ranked.map(({ address, score, recommendation, dealKillers, missingCriticalFacts }) => ({
  address,
  score,
  recommendation,
  dealKillers: dealKillers.length,
  openDueDiligenceItems: missingCriticalFacts.length,
})));

for (const result of ranked) {
  console.log(`\n${result.address}: ${result.recommendation} (${result.score})`);
  if (result.dealKillers.length) console.log('Deal killers:', result.dealKillers.join('; '));
  console.log('NOI:', result.economics.noi, 'DSCR:', result.economics.dscr, 'Cap rate:', result.economics.capRate);
}

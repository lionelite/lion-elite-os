const DEFAULT_WEIGHTS = Object.freeze({
  motivation: 20,
  equity: 15,
  economics: 25,
  physical: 10,
  legal: 10,
  market: 10,
  confidence: 10,
});

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function weightedScore(dimensions, weights = DEFAULT_WEIGHTS) {
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) throw new Error('Scoring weights must total more than zero.');

  const contributions = {};
  let score = 0;

  for (const [dimension, weight] of Object.entries(weights)) {
    const value = clamp(dimensions[dimension]);
    const contribution = (value * weight) / totalWeight;
    contributions[dimension] = Number(contribution.toFixed(2));
    score += contribution;
  }

  return { score: Number(score.toFixed(2)), contributions };
}

function calculateEconomics(property) {
  const price = Number(property.askingPrice || property.offerPrice || 0);
  const grossRent = Number(property.monthlyGrossRent || 0) * 12;
  const expenses = Number(property.annualOperatingExpenses || 0);
  const debtService = Number(property.annualDebtService || 0);
  const repairs = Number(property.estimatedRepairs || 0);
  const noi = grossRent - expenses;
  const capRate = price > 0 ? noi / price : 0;
  const dscr = debtService > 0 ? noi / debtService : null;
  const allInBasis = price + repairs;
  const value = Number(property.estimatedAfterRepairValue || property.estimatedMarketValue || 0);
  const discountToValue = value > 0 ? (value - allInBasis) / value : 0;

  let score = 0;
  score += clamp(capRate * 1000, 0, 35);
  score += dscr === null ? 0 : clamp((dscr - 0.9) * 50, 0, 30);
  score += clamp(discountToValue * 100, 0, 25);
  score += property.positiveCashFlow === true ? 10 : 0;

  return {
    score: clamp(score),
    metrics: {
      grossRent,
      noi,
      capRate: Number(capRate.toFixed(4)),
      dscr: dscr === null ? null : Number(dscr.toFixed(2)),
      allInBasis,
      discountToValue: Number(discountToValue.toFixed(4)),
    },
  };
}

function findDealKillers(property) {
  const killers = [];
  if (property.legalUnitCountVerified === false) killers.push('Illegal or unverified unit count');
  if (property.clearTitleExpected === false) killers.push('Title defect or unresolved ownership issue');
  if (property.insuranceAvailable === false) killers.push('Property currently appears uninsurable');
  if (property.structuralHazard === true) killers.push('Known structural or life-safety hazard');
  if (property.accessDeniedForInspection === true) killers.push('Seller denied required inspection access');
  if (property.financialDocumentsFraudConcern === true) killers.push('Material concern regarding financial-document accuracy');
  return killers;
}

function createChecklist(property) {
  const items = [
    ['Document seller motivation and prior failed contracts', 'Broker / acquisitions manager', property.sellerMotivationVerified],
    ['Verify ownership and seller authority', 'Florida real-estate attorney / title company', property.sellerAuthorityVerified],
    ['Verify legal unit count, zoning, permits, and code issues', 'Attorney + municipality + inspector', property.legalUnitCountVerified],
    ['Review leases, rent roll, deposits, delinquencies, and estoppels', 'Attorney + property manager', property.rentRollVerified],
    ['Complete general multifamily inspection', 'Licensed property inspector', property.generalInspectionComplete],
    ['Confirm roof condition and remaining useful life', 'Licensed roofing contractor', property.roofInspectionComplete],
    ['Inspect electrical systems and panels', 'Licensed electrician', property.electricalInspectionComplete],
    ['Inspect plumbing and perform sewer scope when appropriate', 'Licensed plumber', property.plumbingInspectionComplete],
    ['Inspect HVAC equipment', 'Licensed HVAC contractor', property.hvacInspectionComplete],
    ['Complete WDO/termite inspection', 'Florida-licensed pest inspector', property.wdoInspectionComplete],
    ['Obtain insurance, wind, flood, liability, and loss-of-rent quotes', 'Independent insurance broker', property.insuranceQuoteVerified],
    ['Validate rents, vacancy, maintenance, and management budget', 'Third-party property manager', property.managementBudgetVerified],
    ['Validate loan terms, reserves, guarantees, and closing costs', 'Commercial lender + CPA + attorney', property.financingVerified],
  ];

  return items.map(([task, owner, completed]) => ({ task, owner, completed: completed === true }));
}

function analyzeProperty(property, weights = DEFAULT_WEIGHTS) {
  if (!property || typeof property !== 'object') throw new TypeError('Property input is required.');

  const economics = calculateEconomics(property);
  const dimensions = {
    motivation: clamp(property.motivationScore),
    equity: clamp(property.equityScore),
    economics: economics.score,
    physical: clamp(property.physicalConditionScore),
    legal: clamp(property.legalRiskScore),
    market: clamp(property.marketScore),
    confidence: clamp(property.dataConfidenceScore),
  };

  const weighted = weightedScore(dimensions, weights);
  const dealKillers = findDealKillers(property);
  const missingCriticalFacts = createChecklist(property).filter((item) => !item.completed);

  let recommendation = 'PASS';
  if (dealKillers.length === 0 && weighted.score >= 75) recommendation = 'PURSUE';
  else if (dealKillers.length === 0 && weighted.score >= 55) recommendation = 'WATCH';

  return {
    propertyId: property.id || null,
    address: property.address || 'Unknown address',
    score: weighted.score,
    recommendation,
    dimensions,
    contributions: weighted.contributions,
    economics: economics.metrics,
    dealKillers,
    missingCriticalFacts,
    checklist: createChecklist(property),
  };
}

module.exports = {
  DEFAULT_WEIGHTS,
  analyzeProperty,
  calculateEconomics,
  findDealKillers,
  weightedScore,
};

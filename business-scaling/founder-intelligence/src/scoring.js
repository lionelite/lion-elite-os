const WEIGHTS = Object.freeze({
  coachability: 20,
  ownership: 20,
  execution: 20,
  businessFundamentals: 15,
  financialReadiness: 10,
  systemsMaturity: 10,
  commitment: 5,
});

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function weightedScore(input, weights = WEIGHTS) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const contributions = {};
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const contribution = (clamp(input[key]) * weight) / total;
    contributions[key] = Number(contribution.toFixed(2));
    score += contribution;
  }
  return { score: Number(score.toFixed(2)), contributions };
}

function findRedFlags(application) {
  const flags = [];
  if (application.blamesOthers === true) flags.push('Externalizes responsibility');
  if (application.rejectsDirectFeedback === true) flags.push('Resists direct feedback');
  if (application.requiresGuarantees === true) flags.push('Expects guaranteed outcomes');
  if (application.unwillingToTrackKPIs === true) flags.push('Unwilling to track KPIs');
  if (application.historyOfNonImplementation === true) flags.push('Repeated non-implementation');
  if (application.disrespectsTeam === true) flags.push('Leadership or respect concern');
  if (application.misrepresentsFinancials === true) flags.push('Financial integrity concern');
  return flags;
}

function budgetQualification(application) {
  const monthlyRevenue = Number(application.monthlyRevenue || 0);
  const monthlyProfit = Number(application.monthlyProfit || 0);
  const availableCapital = Number(application.availableCapital || 0);
  const desiredInvestment = Number(application.desiredInvestment || 0);
  const runwayMonths = monthlyProfit > 0 ? availableCapital / monthlyProfit : 0;
  const canFund = availableCapital >= desiredInvestment;

  let tier = 'FOUNDATION';
  if (monthlyRevenue >= 100000 && monthlyProfit > 0 && canFund) tier = 'PRIVATE_ADVISORY';
  else if (monthlyRevenue >= 25000 && monthlyProfit > 0 && canFund) tier = 'GROWTH';
  else if (monthlyRevenue >= 5000 && canFund) tier = 'CORE';

  return { monthlyRevenue, monthlyProfit, availableCapital, desiredInvestment, runwayMonths: Number(runwayMonths.toFixed(1)), canFund, tier };
}

function analyzeFounder(application) {
  if (!application || typeof application !== 'object') throw new TypeError('Application is required.');
  const dimensions = {
    coachability: clamp(application.coachability),
    ownership: clamp(application.ownership),
    execution: clamp(application.execution),
    businessFundamentals: clamp(application.businessFundamentals),
    financialReadiness: clamp(application.financialReadiness),
    systemsMaturity: clamp(application.systemsMaturity),
    commitment: clamp(application.commitment),
  };
  const weighted = weightedScore(dimensions);
  const redFlags = findRedFlags(application);
  const budget = budgetQualification(application);

  let decision = 'DECLINE';
  if (redFlags.length === 0 && weighted.score >= 80 && budget.canFund) decision = 'ELITE_FIT';
  else if (redFlags.length === 0 && weighted.score >= 65 && budget.canFund) decision = 'STRONG_FIT';
  else if (redFlags.length === 0 && weighted.score >= 50) decision = 'NURTURE';

  return { score: weighted.score, decision, dimensions, contributions: weighted.contributions, redFlags, budget };
}

module.exports = { WEIGHTS, analyzeFounder, budgetQualification, findRedFlags, weightedScore };

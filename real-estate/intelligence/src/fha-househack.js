'use strict';

// FHA house-hack acquisition layer for the repeatable model:
// Cleveland (prototype) → stabilize → replicate (Miami, #2) → graduate to
// conventional/DSCR. Narrows the general distressed-property engine
// (scoring.js) to 2–4 unit, owner-occupant-viable, FHA-plausible deals and
// encodes the FHA rules that actually decide these purchases.
//
// IMPORTANT — verify the numbers before relying on them:
//  * FHA loan limits are county- and year-specific. The defaults below are
//    the 2025 national "floor" (low-cost areas, which Cuyahoga County /
//    Cleveland uses). ALWAYS confirm the current figure at HUD's official
//    limit lookup for the subject county before making an offer.
//  * The PITI here is a rough first-pass estimate for screening only, not
//    an underwriting quote. Real MIP, taxes, insurance, and rate vary.
//  * One FHA loan at a time is the general rule; Deal #2 uses a different
//    borrower who independently qualifies and genuinely occupies. This tool
//    screens PROPERTIES; borrower eligibility/occupancy is verified with a
//    lender, not here.

const { analyzeProperty } = require('./scoring');

const DEFAULT_CONFIG = Object.freeze({
  market: 'Cleveland',
  county: 'Cuyahoga',
  minUnits: 2,
  maxUnits: 4,
  downPaymentPct: 0.035,
  // 2025 FHA floor by unit count — VERIFY at the HUD lookup for the county.
  loanLimits: Object.freeze({ 1: 524225, 2: 671200, 3: 811275, 4: 1008300 }),
  // Rough screening assumptions (override per deal / market).
  interestRatePct: 0.07,
  termYears: 30,
  // Annual % of price used to approximate taxes + insurance + MIP together.
  carryingCostAnnualPct: 0.025
});

function monthlyPandI(loanAmount, annualRatePct, termYears) {
  const r = annualRatePct / 12;
  const n = termYears * 12;
  if (loanAmount <= 0) return 0;
  if (r === 0) return loanAmount / n;
  const factor = Math.pow(1 + r, n);
  return (loanAmount * r * factor) / (factor - 1);
}

// First-pass monthly PITI (principal, interest, taxes, insurance, MIP est.).
function estimateMonthlyPITI(price, config = DEFAULT_CONFIG) {
  const loan = price * (1 - config.downPaymentPct);
  const pi = monthlyPandI(loan, config.interestRatePct, config.termYears);
  const carrying = (price * config.carryingCostAnnualPct) / 12;
  return Number((pi + carrying).toFixed(2));
}

function totalMonthlyRent(property) {
  if (Array.isArray(property.unitRents) && property.unitRents.length) {
    return property.unitRents.reduce((sum, r) => sum + Number(r || 0), 0);
  }
  return Number(property.monthlyGrossRent || 0);
}

/**
 * FHA Self-Sufficiency Test — REQUIRED for 3–4 unit FHA purchases: 75% of
 * the property's total gross market rent (all units, including the one the
 * owner occupies) must be >= the monthly PITI. 1–2 unit properties are
 * exempt. This is the single most common reason a 3–4 unit FHA deal dies.
 */
function selfSufficiencyTest(property, config = DEFAULT_CONFIG) {
  const units = Number(property.units || 0);
  const price = Number(property.askingPrice || property.offerPrice || 0);
  const applies = units >= 3 && units <= 4;
  const piti = estimateMonthlyPITI(price, config);
  const netRentalIncome = Number((0.75 * totalMonthlyRent(property)).toFixed(2));
  return {
    applies,
    piti,
    netRentalIncome,
    // Non-applicable (1–2 units) passes by exemption.
    passes: !applies || netRentalIncome >= piti,
    marginMonthly: Number((netRentalIncome - piti).toFixed(2))
  };
}

/**
 * Owner lives in one unit; the others pay the mortgage. Returns the owner's
 * net monthly housing cost (PITI minus the rent from the non-owner units).
 * Negative means the property pays the owner to live there.
 */
function houseHackPosition(property, config = DEFAULT_CONFIG) {
  const units = Number(property.units || 0);
  const price = Number(property.askingPrice || property.offerPrice || 0);
  const piti = estimateMonthlyPITI(price, config);

  let otherUnitsRent;
  if (Array.isArray(property.unitRents) && property.unitRents.length) {
    const sorted = [...property.unitRents].map(Number).sort((a, b) => a - b);
    sorted.pop(); // owner occupies the highest-rent unit (conservative)
    otherUnitsRent = sorted.reduce((sum, r) => sum + r, 0);
  } else if (units > 0) {
    otherUnitsRent = totalMonthlyRent(property) * ((units - 1) / units);
  } else {
    otherUnitsRent = 0;
  }
  return {
    piti,
    otherUnitsRent: Number(otherUnitsRent.toFixed(2)),
    ownerNetHousingCost: Number((piti - otherUnitsRent).toFixed(2)),
    livesForFree: piti - otherUnitsRent <= 0
  };
}

function distressScore(property) {
  const signals = [
    ['vacancy', property.hasVacancy === true || Number(property.vacantUnits || 0) > 0, 22],
    ['code_violations', property.codeViolations === true || Number(property.openCodeViolations || 0) > 0, 20],
    ['pre_foreclosure', property.preForeclosure === true, 22],
    ['tax_distress', property.taxDelinquent === true || Number(property.taxArrears || 0) > 0, 18],
    ['absentee_owner', property.absenteeOwner === true, 10],
    ['tired_landlord', property.longtimeOwner === true || property.inheritedProperty === true, 8]
  ];
  const matched = signals.filter(([, present]) => present);
  const score = Math.min(100, matched.reduce((sum, [, , pts]) => sum + pts, 0));
  return { score, signals: matched.map(([name]) => name) };
}

// Value-add / equity spread: after-repair value vs all-in basis. Higher =
// easier to fund Deal #2 later via refi/HELOC.
function equitySpread(property, config = DEFAULT_CONFIG) {
  const price = Number(property.askingPrice || property.offerPrice || 0);
  const repairs = Number(property.estimatedRepairs || 0);
  const arv = Number(property.estimatedAfterRepairValue || property.estimatedMarketValue || 0);
  const allIn = price + repairs;
  const spread = arv > 0 ? (arv - allIn) / arv : 0;
  return { arv, allIn, spreadPct: Number((spread * 100).toFixed(1)), score: Math.max(0, Math.min(100, spread * 250)) };
}

function fhaDealKillers(property, config = DEFAULT_CONFIG) {
  const killers = [];
  const units = Number(property.units || 0);
  const price = Number(property.askingPrice || property.offerPrice || 0);

  if (units < config.minUnits || units > config.maxUnits) {
    killers.push(`Unit count ${units} outside FHA house-hack range (${config.minUnits}-${config.maxUnits})`);
  }
  const limit = config.loanLimits[units];
  const loan = price * (1 - config.downPaymentPct);
  if (limit && loan > limit) {
    killers.push(`Loan ~$${Math.round(loan).toLocaleString()} exceeds FHA ${units}-unit limit $${limit.toLocaleString()} (verify county limit)`);
  }
  if (property.ownerOccupiable === false) {
    killers.push('No owner-occupiable unit — FHA requires principal residence');
  }
  if (property.habitableOrFinanceable === false && property.fha203kCandidate !== true) {
    killers.push('Condition not FHA-financeable and not flagged as a 203(k) rehab candidate');
  }
  const sst = selfSufficiencyTest(property, config);
  if (sst.applies && !sst.passes) {
    killers.push(`Fails FHA Self-Sufficiency Test (75% rent $${sst.netRentalIncome} < PITI $${sst.piti})`);
  }
  return killers;
}

/**
 * Full FHA house-hack assessment for one property. Combines the general
 * engine's score with the FHA-specific gates and fit signals.
 */
function assessFhaHouseHack(property, config = DEFAULT_CONFIG) {
  const units = Number(property.units || 0);
  const general = analyzeProperty(property);
  const distress = distressScore(property);
  const equity = equitySpread(property, config);
  const position = houseHackPosition(property, config);
  const sst = selfSufficiencyTest(property, config);
  const killers = fhaDealKillers(property, config);

  // Unit-count preference: 4 best, then 3, then 2 (more units = more rent
  // covering the payment and more scale toward Deal #2).
  const unitFit = units === 4 ? 100 : units === 3 ? 85 : units === 2 ? 65 : 0;
  // Reward properties where rent covers most/all of the payment.
  const coverage = position.piti > 0
    ? Math.max(0, Math.min(100, (position.otherUnitsRent / position.piti) * 100))
    : 0;

  const fitScore = Number((
    unitFit * 0.25 +
    distress.score * 0.25 +
    coverage * 0.25 +
    equity.score * 0.15 +
    general.score * 0.10
  ).toFixed(2));

  let recommendation = 'PASS';
  if (killers.length === 0 && general.dealKillers.length === 0 && fitScore >= 72) recommendation = 'PURSUE';
  else if (killers.length === 0 && general.dealKillers.length === 0 && fitScore >= 55) recommendation = 'WATCH';

  return {
    propertyId: property.id || null,
    address: property.address || 'Unknown address',
    market: property.market || property.city || null,
    units,
    strategy: 'fha-househack',
    fitScore,
    recommendation,
    fhaDealKillers: killers,
    generalDealKillers: general.dealKillers,
    generalScore: general.score,
    signals: distress.signals,
    selfSufficiency: sst,
    houseHack: position,
    equity,
    // Surface the estimate caveats on every result so no one mistakes the
    // screening PITI / loan limit for underwriting.
    disclaimers: [
      'PITI is a screening estimate, not an underwriting quote.',
      'Verify the FHA loan limit for the county/year at the HUD lookup.',
      'Self-Sufficiency Test uses estimated rents; the appraiser sets market rent.',
      'Borrower must independently qualify and genuinely occupy as principal residence.'
    ]
  };
}

/**
 * Narrow a stream of properties to the Cleveland FHA house-hack profile:
 * in-market, 2–4 units, ranked by fit. Off-market/oversized properties are
 * dropped (with a reason) rather than scored.
 */
function filterFhaCandidates(properties = [], config = DEFAULT_CONFIG) {
  const inMarket = (p) => {
    if (!config.market) return true;
    const hay = `${p.market || ''} ${p.city || ''} ${p.county || ''} ${p.address || ''}`.toLowerCase();
    return hay.includes(config.market.toLowerCase()) || (config.county && hay.includes(config.county.toLowerCase()));
  };

  const candidates = [];
  const excluded = [];
  for (const property of properties) {
    const units = Number(property.units || 0);
    if (!inMarket(property)) { excluded.push({ id: property.id, reason: 'out_of_market' }); continue; }
    if (units < config.minUnits || units > config.maxUnits) { excluded.push({ id: property.id, reason: `units_${units}` }); continue; }
    candidates.push(assessFhaHouseHack(property, config));
  }
  candidates.sort((a, b) => b.fitScore - a.fitScore);
  return { candidates, excluded };
}

module.exports = {
  DEFAULT_CONFIG,
  monthlyPandI,
  estimateMonthlyPITI,
  selfSufficiencyTest,
  houseHackPosition,
  distressScore,
  equitySpread,
  fhaDealKillers,
  assessFhaHouseHack,
  filterFhaCandidates
};

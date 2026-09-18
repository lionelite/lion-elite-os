'use strict';

// Step 1 support: find the expensive operational problem and size it in money.
//
// The pitch is never "we build AI systems". It is "you are losing $X/month in
// leads you never called back, and here is what it costs to stop that". This
// module does that arithmetic from facts collected on a discovery call, and it
// is deliberately conservative: an inflated number closes a deal we then cannot
// defend at the 90-day review, which kills the retainer that is most of the
// lifetime value.
//
// It also DISQUALIFIES. Most businesses should not buy this. A prospect whose
// customer is worth $300 cannot rationally pay $20,000 for lead recovery, and
// selling it to them anyway produces a refund request and a bad reference.

const { vertical } = require('./offer');

// Fraction of demonstrably-missed leads we model ourselves recovering. Not 100%:
// a lead that went cold three weeks ago is often unrecoverable no matter how
// fast the follow-up is. 0.35 is the planning default and is stated as an
// assumption in every proposal so the client sees it.
const DEFAULT_RECOVERY_RATE = 0.35;

// A recovered lead does NOT close at the same rate as a lead the sales team
// worked properly from the start — it is older, colder, and was already ignored
// once. We model recovered leads closing at 60% of the client's normal rate.
// Skipping this discount is the single easiest way to produce a proposal number
// that cannot survive the 90-day review.
const RECOVERED_CLOSE_DISCOUNT = 0.6;

// Qualification floors. Below these the value story does not hold.
const FLOORS = Object.freeze({
  averageCustomerValue: 1000, // "one recovered customer is worth thousands"
  monthlyInboundLeads: 25,    // below this, missed-lead volume is noise
  annualRecoverableValue: 30000,
  // Two separate tests, because a buyer asks two separate questions.
  //
  // buildPaybackMonths is the capital question: "how fast does the project pay
  // for itself?" It is the sharp, persuasive number and the hard gate.
  //
  // roiMultiple is the whole-relationship question: build + 12 months of
  // retainer against year-one value. Its floor is deliberately lower than the
  // payback gate implies, because the retainer is not pure cost — it is what
  // sustains and grows the recovered revenue. Setting this at 3x rejects deals
  // that pay back in under three months, which is the wrong answer.
  buildPaybackMonths: 6,
  roiMultiple: 2,
  // Below this we still proceed, but the deal is not a slam dunk and the
  // proposal should lead with payback rather than annual ROI.
  roiComfortable: 3,
  // A retainer above this share of the monthly value it manages is hard to
  // defend at renewal. Not a blocker — a signal to offer lighter-touch support.
  retainerShareOfMonthlyValue: 0.25,
});

// Loaded cost of an hour of the client's staff time when they have not told us.
// Used only for the hours-saved half of the case, which is always the secondary
// argument — it supports the revenue number, it does not replace it.
const DEFAULT_LOADED_HOURLY_COST = 35;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rate(value, fallback = 0) {
  const n = num(value, fallback);
  if (n < 0) return 0;
  // Accept either 0.4 or 40 for "40%".
  return n > 1 ? Math.min(n / 100, 1) : Math.min(n, 1);
}

function round(n, places = 0) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Size the leak.
 *
 * Expected discovery facts:
 *   monthlyInboundLeads      total inbound of every kind
 *   missedLeadRate           share never contacted, or contacted too late to matter
 *   currentCloseRate         share of properly-worked leads that become customers
 *   averageCustomerValue     first-year value of one customer
 *   manualFollowUpHoursWeekly staff hours currently spent chasing leads by hand
 *   loadedHourlyCost         fully-loaded cost of one of those hours
 *   recoveryRate             override for DEFAULT_RECOVERY_RATE
 */
function sizeOpportunity(facts = {}) {
  const monthlyInboundLeads = num(facts.monthlyInboundLeads);
  const missedLeadRate = rate(facts.missedLeadRate);
  const currentCloseRate = rate(facts.currentCloseRate);
  const averageCustomerValue = num(facts.averageCustomerValue);
  const recoveryRate = rate(facts.recoveryRate, DEFAULT_RECOVERY_RATE) || DEFAULT_RECOVERY_RATE;

  const missedLeadsMonthly = monthlyInboundLeads * missedLeadRate;
  const recoveredLeadsMonthly = missedLeadsMonthly * recoveryRate;
  const effectiveCloseRate = currentCloseRate * RECOVERED_CLOSE_DISCOUNT;
  const recoveredCustomersMonthly = recoveredLeadsMonthly * effectiveCloseRate;
  const revenueGainedMonthly = recoveredCustomersMonthly * averageCustomerValue;

  const hoursWeekly = num(facts.manualFollowUpHoursWeekly);
  const hourlyCost = num(facts.loadedHourlyCost, DEFAULT_LOADED_HOURLY_COST) || DEFAULT_LOADED_HOURLY_COST;
  // We model reclaiming 70% of manual chase time — coordination never goes to zero.
  const hoursSavedWeekly = hoursWeekly * 0.7;
  const costReducedMonthly = hoursSavedWeekly * hourlyCost * (52 / 12);

  const annualRecoverableValue = (revenueGainedMonthly + costReducedMonthly) * 12;

  return {
    missedLeadsMonthly: round(missedLeadsMonthly, 1),
    recoveredLeadsMonthly: round(recoveredLeadsMonthly, 1),
    effectiveCloseRate: round(effectiveCloseRate, 4),
    recoveredCustomersMonthly: round(recoveredCustomersMonthly, 2),
    revenueGainedMonthly: round(revenueGainedMonthly),
    revenueGainedAnnual: round(revenueGainedMonthly * 12),
    hoursSavedWeekly: round(hoursSavedWeekly, 1),
    costReducedMonthly: round(costReducedMonthly),
    costReducedAnnual: round(costReducedMonthly * 12),
    annualRecoverableValue: round(annualRecoverableValue),
    assumptions: {
      recoveryRate,
      recoveredCloseDiscount: RECOVERED_CLOSE_DISCOUNT,
      manualTimeReclaimed: 0.7,
      loadedHourlyCost: hourlyCost,
      note: 'Recovery rate, the recovered-lead close discount and the time-reclaim rate are planning assumptions, stated in the proposal. Lead volume, missed rate, close rate and customer value are the client\'s own reported figures.',
    },
  };
}

/**
 * Qualify the prospect. Returns a verdict plus the reasons behind it.
 *
 * Verdicts:
 *   PURSUE      — the math works; send the proposal.
 *   DISCOVERY   — plausible but a required fact is missing or soft. Get it
 *                 before quoting. Quoting on a guess is how you underprice.
 *   DISQUALIFY  — a floor is broken. Say so and move on.
 *
 * `blockers` are floor failures. `gaps` are missing facts. A prospect with any
 * blocker is DISQUALIFY regardless of how good the rest looks — this is the
 * same fail-closed posture the outreach validation engine uses.
 */
function qualifyClient(client = {}) {
  if (!client || typeof client !== 'object') throw new TypeError('Client record is required.');

  const opportunity = sizeOpportunity(client);
  const blockers = [];
  const gaps = [];
  const notes = [];

  const averageCustomerValue = num(client.averageCustomerValue);
  const monthlyInboundLeads = num(client.monthlyInboundLeads);

  if (!monthlyInboundLeads) gaps.push('monthlyInboundLeads not captured');
  else if (monthlyInboundLeads < FLOORS.monthlyInboundLeads) {
    blockers.push(`Inbound volume ${monthlyInboundLeads}/mo is below the ${FLOORS.monthlyInboundLeads}/mo floor — there is no recoverable pool to automate.`);
  }

  if (!averageCustomerValue) gaps.push('averageCustomerValue not captured');
  else if (averageCustomerValue < FLOORS.averageCustomerValue) {
    blockers.push(`Average customer value $${averageCustomerValue} is under the $${FLOORS.averageCustomerValue} floor — one recovered customer cannot justify the build.`);
  }

  if (!num(client.currentCloseRate)) gaps.push('currentCloseRate not captured');
  if (client.missedLeadRate === undefined || client.missedLeadRate === null) gaps.push('missedLeadRate not captured');

  const v = vertical(client.verticalId);
  if (client.verticalId && !v) gaps.push(`Unknown verticalId "${client.verticalId}" — not one of our target verticals`);
  if (v && averageCustomerValue && averageCustomerValue < v.minCustomerValue) {
    // Not a blocker: it is a "are we talking about the same thing" signal.
    notes.push(`Reported customer value $${averageCustomerValue} is below the $${v.minCustomerValue} typical for ${v.name}. Confirm whether that figure is per-job or per-customer-lifetime before pricing.`);
  }

  // The value floor is only meaningful once every input that feeds it is on
  // record. Judging it against a figure computed from a missing close rate would
  // disqualify a good prospect for our own incomplete notes — which is a
  // discovery failure, not a prospect failure.
  const valueInputsComplete = ['monthlyInboundLeads', 'missedLeadRate', 'currentCloseRate', 'averageCustomerValue']
    .every((field) => client[field] !== undefined && client[field] !== null && num(client[field]) > 0);
  if (valueInputsComplete && opportunity.annualRecoverableValue < FLOORS.annualRecoverableValue) {
    blockers.push(`Annual recoverable value $${opportunity.annualRecoverableValue} is under the $${FLOORS.annualRecoverableValue} floor — the engagement cannot pay for itself in year one.`);
  }

  // Decision-maker and authority checks. A perfect value case sold to someone
  // who cannot sign produces a 6-week stall and no deposit.
  if (client.decisionMakerEngaged === false) blockers.push('No economic decision-maker engaged — nobody in the room can authorize the spend.');
  else if (client.decisionMakerEngaged === undefined) gaps.push('decisionMakerEngaged not confirmed');

  if (client.wantsHourlyBilling === true) {
    blockers.push('Prospect insists on hourly billing — incompatible with fixed-price milestones and the margin model.');
  }
  if (client.wantsRevenueGuarantee === true) {
    blockers.push('Prospect requires a guaranteed revenue outcome — we sell a system and a forecast, not a guarantee.');
  }

  const complianceFlags = v ? [...v.complianceFlags] : [];
  if (complianceFlags.length) {
    notes.push(`Compliance flags ${complianceFlags.join(', ')} apply: contractor access must be restricted to synthetic/redacted data and the required agreements signed before any assignment.`);
  }

  let verdict = 'PURSUE';
  if (blockers.length) verdict = 'DISQUALIFY';
  else if (gaps.length) verdict = 'DISCOVERY';

  return { verdict, blockers, gaps, notes, opportunity, complianceFlags, floors: FLOORS };
}

/**
 * ROI check on a concrete price. Kept separate from qualifyClient because the
 * price comes from pricing.js, which itself consumes the qualification — this
 * is the closing of that loop.
 *
 * `roiMultiple` compares year-one recoverable value against everything the
 * client pays in year one (build + 12 retainer months). If it is under 3x, the
 * deal is not compelling enough to survive a CFO's scrutiny.
 */
function checkRoi(opportunity, { projectPrice = 0, monthlyRetainer = 0 } = {}) {
  const price = num(projectPrice);
  const retainer = num(monthlyRetainer);
  const value = num(opportunity && opportunity.annualRecoverableValue);
  const monthlyValue = value / 12;

  const yearOneCost = price + retainer * 12;
  const roiMultiple = yearOneCost > 0 ? value / yearOneCost : 0;
  const buildPaybackMonths = monthlyValue > 0 ? round(price / monthlyValue, 1) : null;
  const retainerShare = monthlyValue > 0 ? retainer / monthlyValue : 0;

  const blockers = [];
  const warnings = [];

  if (buildPaybackMonths === null) {
    blockers.push('No value figure available — payback cannot be computed, so the price cannot be defended.');
  } else if (buildPaybackMonths > FLOORS.buildPaybackMonths) {
    blockers.push(`Build pays back in ${buildPaybackMonths} months, past the ${FLOORS.buildPaybackMonths}-month gate. The capital case does not hold at this price.`);
  }
  if (yearOneCost > 0 && roiMultiple < FLOORS.roiMultiple) {
    blockers.push(`Year-one ROI ${round(roiMultiple, 2)}x is below the ${FLOORS.roiMultiple}x floor across build plus retainer.`);
  } else if (yearOneCost > 0 && roiMultiple < FLOORS.roiComfortable) {
    warnings.push(`Year-one ROI ${round(roiMultiple, 2)}x is under the ${FLOORS.roiComfortable}x comfort line. Lead the proposal with the ${buildPaybackMonths}-month payback, not the annual multiple.`);
  }
  if (retainer > 0 && retainerShare > FLOORS.retainerShareOfMonthlyValue) {
    warnings.push(`The $${round(retainer)}/mo retainer is ${round(retainerShare * 100)}% of the $${round(monthlyValue)}/mo this system produces. Offer quarterly optimization instead of a full monthly retainer — a fee that large relative to the result will not renew.`);
  }

  return {
    yearOneCost: round(yearOneCost),
    yearOneValue: round(value),
    monthlyValue: round(monthlyValue),
    roiMultiple: round(roiMultiple, 2),
    buildRoiMultiple: price > 0 ? round(value / price, 2) : 0,
    paybackMonths: buildPaybackMonths,
    retainerShareOfMonthlyValue: round(retainerShare, 3),
    acceptable: blockers.length === 0,
    blockers,
    warnings,
    floors: {
      buildPaybackMonths: FLOORS.buildPaybackMonths,
      roiMultiple: FLOORS.roiMultiple,
      roiComfortable: FLOORS.roiComfortable,
    },
  };
}

module.exports = {
  DEFAULT_RECOVERY_RATE,
  RECOVERED_CLOSE_DISCOUNT,
  DEFAULT_LOADED_HOURLY_COST,
  FLOORS,
  sizeOpportunity,
  qualifyClient,
  checkRoi,
};

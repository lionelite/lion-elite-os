'use strict';

// Step 4: retain the margin — enforced in code, not in good intentions.
//
// The reference deal:
//   client pays            $20,000
//   developer delivery     $5,000 – $8,000
//   software / operating   $1,000 – $2,000
//   gross profit           $10,000 – $14,000   (50% – 70%)
//   + management retainer  $2,000 – $5,000 / month
//
// Every way that deal degrades is a rule here:
//   - price set from cost instead of client value      → priceFromValue()
//   - developer cost creeping past its share           → DEV_COST_CAP_RATIO
//   - "just add this one thing"                        → margin floor blocks it
//   - deposit too small to fund delivery               → DEPOSIT_FLOOR + cash flow
//   - hourly billing                                   → no hourly path exists here
//
// quotePricing() returns `approved: false` with reasons rather than a quietly
// bad quote. A blocked quote is a decision for the owner, not something to
// work around by trimming the offer.

const { checkRoi } = require('./qualification');

const MARGIN_FLOOR = 0.5;      // below 50% gross the model does not work
const MARGIN_TARGET = 0.6;     // what we aim for
const DEV_COST_CAP_RATIO = 0.4; // developer delivery ≤ 40% of project price ($8k of $20k)
const OPS_COST_CAP_RATIO = 0.1; // software/operating ≤ 10% of project price ($2k of $20k)
const DEPOSIT_FLOOR = 0.5;     // 50–70% upfront; 50% is the hard floor
const DEPOSIT_TARGET = 0.6;
const DEPOSIT_CEILING = 0.7;

// Share of year-one recoverable value the BUILD is priced at. 18% is the default
// ask: high enough to be a real business, low enough that the build's payback
// stays inside a quarter once the retainer is added on top.
const VALUE_CAPTURE_TARGET = 0.18;
const VALUE_CAPTURE_CEILING = 0.33; // never price above a third of year-one value

const PRICE_FLOOR = 12000;     // below this the engagement cannot absorb our own delivery overhead

// The productized offer sells inside a band. This is not timidity about money —
// it is what "productized" means: the same fixed scope, delivered the same way,
// for a predictable price. A value-based calculation on a high-volume client can
// return $130,000, and quoting that for this scope invites a procurement
// process, three competing bids, and a custom-software expectation we did not
// scope. Above the ceiling the deal is real but it is NOT this product: it needs
// a hand-built enterprise quote, which is an owner decision, so the engine
// clamps to the ceiling and raises `escalateToCustom`.
const PRODUCTIZED_CEILING = 45000;
const RETAINER_MIN = 2000;
const RETAINER_MAX = 5000;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(n, places = 0) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function roundTo(n, step) {
  return Math.round(n / step) * step;
}

function money(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

/**
 * Derive the project price from the client's own value number, then clamp it
 * between what our costs require and what the ROI story can carry.
 *
 * This is the anti-pattern killer: pricing from estimated developer hours makes
 * the price a function of our cost, which is exactly how an agency ends up
 * charging $6,000 for a system worth $180,000/yr to the buyer.
 */
function priceFromValue(opportunity, { estimatedDeveloperCost = 0, estimatedOpsCost = 0, valueCaptureRate = VALUE_CAPTURE_TARGET } = {}) {
  const annualValue = num(opportunity && opportunity.annualRecoverableValue);
  const capture = Math.min(num(valueCaptureRate, VALUE_CAPTURE_TARGET) || VALUE_CAPTURE_TARGET, VALUE_CAPTURE_CEILING);

  const valueBasedPrice = annualValue * capture;

  // Floor from cost: the price that still clears the margin floor after both
  // cost lines. price ≥ costs / (1 - MARGIN_FLOOR).
  const dev = num(estimatedDeveloperCost);
  const costs = dev + num(estimatedOpsCost);
  const costFloor = costs > 0 ? costs / (1 - MARGIN_FLOOR) : 0;

  // Second cost floor: the developer-cost cap is a ratio, so a build with an
  // expensive delivery estimate has a minimum price of its own. Deriving it here
  // means the quote satisfies the cap instead of quotePricing() merely reporting
  // that it was breached.
  const devCapFloor = dev > 0 ? dev / DEV_COST_CAP_RATIO : 0;

  const ceiling = annualValue * VALUE_CAPTURE_CEILING;

  const floor = Math.max(PRICE_FLOOR, costFloor, devCapFloor);
  let recommended = Math.max(valueBasedPrice, floor);

  // ROI ceiling first: never price above a third of the year-one value.
  let clampedByCeiling = false;
  if (ceiling > 0 && recommended > ceiling) {
    recommended = ceiling;
    clampedByCeiling = true;
  }

  // Then the productized band ceiling.
  let escalateToCustom = false;
  if (recommended > PRODUCTIZED_CEILING) {
    recommended = PRODUCTIZED_CEILING;
    escalateToCustom = true;
  }

  // Quote in clean $500 increments — a price of $19,472 reads as a cost
  // build-up and invites line-item negotiation. Round UP when a floor is
  // binding, so rounding can never drop the quote back under its own floor.
  const nearFloor = Math.abs(recommended - floor) < 500;
  const recommendedPrice = nearFloor ? Math.ceil(recommended / 500) * 500 : roundTo(recommended, 500);

  return {
    recommendedPrice,
    valueBasedPrice: round(valueBasedPrice),
    costFloor: round(costFloor),
    devCapFloor: round(devCapFloor),
    priceFloor: round(floor),
    valueCeiling: round(ceiling),
    valueCaptureRate: capture,
    // True when our own cost floor exceeds what the client's value can carry —
    // meaning this build is too expensive for this client, at any margin.
    infeasible: ceiling > 0 && floor > ceiling,
    clampedByCeiling,
    productizedCeiling: PRODUCTIZED_CEILING,
    escalateToCustom,
    escalationNote: escalateToCustom
      ? `Value-based price ${money(valueBasedPrice)} exceeds the ${money(PRODUCTIZED_CEILING)} productized ceiling. Quoted at the ceiling. This client's economics justify a custom enterprise engagement — price that by hand, with a larger retainer, as an owner decision.`
      : null,
  };
}

/**
 * Recommend the monthly management + optimization retainer.
 *
 * Priced off the value the system produces monthly, bounded to the $2k–$5k band.
 * The retainer is what turns a one-off $20k into an $80k+ relationship, so it is
 * never a throw-in.
 */
function recommendRetainer(opportunity) {
  const monthlyValue = num(opportunity && opportunity.annualRecoverableValue) / 12;
  const raw = monthlyValue * 0.1; // 10% of the monthly value it produces
  const bounded = Math.min(Math.max(raw, RETAINER_MIN), RETAINER_MAX);
  return { monthlyRetainer: roundTo(bounded, 250), floor: RETAINER_MIN, ceiling: RETAINER_MAX, basis: round(monthlyValue) };
}

/**
 * The margin gate. Every quote goes through this before it reaches a client.
 */
function quotePricing({
  projectPrice,
  developerCost,
  opsCost = 0,
  depositRate = DEPOSIT_TARGET,
  monthlyRetainer = 0,
  opportunity = null,
} = {}) {
  const price = num(projectPrice);
  const dev = num(developerCost);
  const ops = num(opsCost);
  const deposit = num(depositRate, DEPOSIT_TARGET);

  const blockers = [];
  const warnings = [];

  if (price <= 0) blockers.push('Project price must be greater than zero.');
  if (dev < 0 || ops < 0) blockers.push('Cost inputs cannot be negative.');

  const totalCost = dev + ops;
  const grossProfit = price - totalCost;
  const grossMargin = price > 0 ? grossProfit / price : 0;

  if (price > 0 && price < PRICE_FLOOR) {
    blockers.push(`Project price $${round(price)} is below the $${PRICE_FLOOR} engagement floor.`);
  }
  if (price > 0 && grossMargin < MARGIN_FLOOR) {
    blockers.push(`Gross margin ${round(grossMargin * 100, 1)}% is below the ${MARGIN_FLOOR * 100}% floor (profit $${round(grossProfit)} on $${round(price)}).`);
  } else if (price > 0 && grossMargin < MARGIN_TARGET) {
    warnings.push(`Gross margin ${round(grossMargin * 100, 1)}% is under the ${MARGIN_TARGET * 100}% target. Acceptable, but there is no room for a scope surprise.`);
  }
  if (price > 0 && dev > price * DEV_COST_CAP_RATIO) {
    blockers.push(`Developer cost $${round(dev)} exceeds ${DEV_COST_CAP_RATIO * 100}% of price ($${round(price * DEV_COST_CAP_RATIO)}). Re-scope the build or raise the price.`);
  }
  if (price > 0 && ops > price * OPS_COST_CAP_RATIO) {
    warnings.push(`Software/operating cost $${round(ops)} exceeds ${OPS_COST_CAP_RATIO * 100}% of price. Check for a tool the client should be paying for directly.`);
  }
  if (deposit < DEPOSIT_FLOOR) {
    blockers.push(`Deposit ${round(deposit * 100, 1)}% is below the ${DEPOSIT_FLOOR * 100}% floor. We do not fund a client's build from our own working capital.`);
  }
  if (deposit > DEPOSIT_CEILING) {
    warnings.push(`Deposit ${round(deposit * 100, 1)}% exceeds the ${DEPOSIT_CEILING * 100}% norm — fine if the client agreed, but it is not the standard ask.`);
  }

  const retainer = num(monthlyRetainer);
  if (retainer > 0 && retainer < RETAINER_MIN) {
    warnings.push(`Retainer $${round(retainer)}/mo is below the $${RETAINER_MIN} band. Management and optimization time will not be covered.`);
  }
  if (retainer === 0) {
    warnings.push('No management retainer attached. The build is the smaller half of the lifetime value — attach one before the proposal goes out.');
  }

  const depositAmount = roundTo(price * deposit, 50);
  const balanceAmount = round(price - depositAmount);

  const roi = opportunity ? checkRoi(opportunity, { projectPrice: price, monthlyRetainer: retainer }) : null;
  if (roi) {
    blockers.push(...roi.blockers);
    warnings.push(...roi.warnings);
  }

  return {
    approved: blockers.length === 0,
    blockers,
    warnings,
    projectPrice: round(price),
    developerCost: round(dev),
    opsCost: round(ops),
    totalCost: round(totalCost),
    grossProfit: round(grossProfit),
    grossMargin: round(grossMargin, 4),
    grossMarginPct: round(grossMargin * 100, 1),
    depositRate: deposit,
    depositAmount,
    balanceAmount,
    monthlyRetainer: round(retainer),
    annualRetainerValue: round(retainer * 12),
    yearOneRevenue: round(price + retainer * 12),
    // Year-one profit assumes retainer delivery costs ~25% of the retainer
    // (our own time plus an occasional contractor tweak).
    yearOneGrossProfit: round(grossProfit + retainer * 12 * 0.75),
    roi,
  };
}

/**
 * Cash-flow check across the milestone schedule.
 *
 * The rule: the deposit must cover every developer payout that falls due before
 * the client's balance payment. If it does not, we are lending the client money
 * at 0% and carrying the delivery risk — the exact position the 50–70% deposit
 * exists to prevent.
 */
function checkCashFlow({ depositAmount = 0, balanceAmount = 0, milestones = [] } = {}) {
  let cash = num(depositAmount);
  const ledger = [{ event: 'Client deposit received', amount: round(cash), balance: round(cash) }];
  let lowest = cash;

  for (const m of milestones) {
    const payout = num(m.developerPayout);
    // The final milestone is accepted, then the client's balance is invoiced and
    // collected before that milestone's payout clears.
    if (m.triggersClientBalance) {
      cash += num(balanceAmount);
      ledger.push({ event: 'Client balance received', amount: round(num(balanceAmount)), balance: round(cash) });
    }
    cash -= payout;
    ledger.push({ event: `Developer payout — ${m.name || m.id}`, amount: round(-payout), balance: round(cash) });
    if (cash < lowest) lowest = cash;
  }

  return {
    solvent: lowest >= 0,
    lowestBalance: round(lowest),
    finalBalance: round(cash),
    ledger,
    warning: lowest < 0
      ? `Schedule goes $${round(Math.abs(lowest))} negative before the client's balance lands. Raise the deposit or move a developer payout later.`
      : null,
  };
}

module.exports = {
  MARGIN_FLOOR,
  MARGIN_TARGET,
  DEV_COST_CAP_RATIO,
  OPS_COST_CAP_RATIO,
  DEPOSIT_FLOOR,
  DEPOSIT_TARGET,
  DEPOSIT_CEILING,
  VALUE_CAPTURE_TARGET,
  VALUE_CAPTURE_CEILING,
  PRICE_FLOOR,
  PRODUCTIZED_CEILING,
  RETAINER_MIN,
  RETAINER_MAX,
  priceFromValue,
  recommendRetainer,
  quotePricing,
  checkCashFlow,
};

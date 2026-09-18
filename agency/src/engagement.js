'use strict';

// The composition layer: one client record in, one complete engagement plan out.
//
//   qualify (step 1) → price (step 4) → architect (step 2) → assign & gate
//   access (step 3) → control the channel (step 5)
//
// The ordering is deliberate and is itself a business rule. Price is derived
// from the client's value BEFORE the build is scoped, so scope is fitted to a
// price that works rather than a price being fitted to whatever was scoped in a
// sales call. And qualification runs first, so a disqualified prospect never gets
// a proposal generated at all.
//
// planEngagement() never throws on a bad deal — it returns `proceed: false` with
// the reasons, because "this deal should not happen" is a normal, frequent,
// useful answer.

const { OFFER_ID, OFFER_STATEMENT, resolveCapabilities, vertical } = require('./offer');
const { qualifyClient } = require('./qualification');
const { priceFromValue, recommendRetainer, quotePricing, checkCashFlow, DEPOSIT_TARGET } = require('./pricing');
const { buildDeliveryPlan } = require('./delivery-plan');
const { revocationChecklist } = require('./access');

// Planning cost of contractor delivery per capability, at our bench rates for a
// narrowly specified fixed-price ticket. These are the numbers that keep the
// reference deal inside its $5k–$8k delivery band; revise them from recorded
// actuals (the `estimate-variance` QC item exists to feed exactly this).
const DEVELOPER_COST_PER_CAPABILITY = Object.freeze({
  'lead-capture': 1500,
  'follow-up': 1700,
  qualification: 1300,
  scheduling: 1000,
  reporting: 1400,
});
const DEVELOPER_COST_LAUNCH = 800;

// Our own software/operating cost for one engagement: hosting, monitoring,
// model usage, and the share of our tooling this build consumes.
const OPS_COST_BASE = 600;
const OPS_COST_PER_CAPABILITY = 200;

function round(n, places = 0) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Estimate our two cost lines for a given capability mix. Complexity multipliers
 * are applied for the things that genuinely cost more: legacy systems with no
 * API, unusual channel counts, and regulated data handling.
 */
function estimateCosts(capabilities, client = {}) {
  let developer = DEVELOPER_COST_LAUNCH;
  for (const cap of capabilities) developer += DEVELOPER_COST_PER_CAPABILITY[cap.id] || 0;

  const multipliers = [];
  if (client.legacySystemWithoutApi === true) { developer *= 1.25; multipliers.push('Legacy system without an API: +25%'); }
  const channels = Number(client.channelCount);
  if (Number.isFinite(channels) && channels > 3) {
    const extra = 1 + 0.08 * (channels - 3);
    developer *= extra;
    multipliers.push(`${channels} intake channels: +${round((extra - 1) * 100)}%`);
  }
  const flags = (vertical(client.verticalId) || {}).complianceFlags || [];
  if (flags.length) { developer *= 1.15; multipliers.push(`Regulated data (${flags.join(', ')}): +15% for synthetic-fixture development`); }

  const ops = OPS_COST_BASE + OPS_COST_PER_CAPABILITY * capabilities.length;

  return {
    developerCost: Math.round(developer / 50) * 50,
    opsCost: ops,
    multipliers,
  };
}

/**
 * Plan a complete engagement.
 *
 * `client` carries the discovery facts consumed by qualification.js plus:
 *   ref                 short slug used to namespace tickets (required)
 *   name                business name
 *   verticalId          one of offer.TARGET_VERTICALS
 *   capabilities        subset of offer.CAPABILITIES ids (defaults to all)
 *   depositRate         override the 60% default (floor 50%)
 *   legacySystemWithoutApi / channelCount   cost multipliers
 */
function planEngagement(client = {}) {
  if (!client || typeof client !== 'object') throw new TypeError('Client record is required.');
  const ref = client.ref || client.id;
  if (!ref) throw new TypeError('client.ref is required — tickets are namespaced by it.');

  const qualification = qualifyClient(client);
  const capabilities = resolveCapabilities(client.capabilities);
  const costs = estimateCosts(capabilities, client);
  const complianceFlags = qualification.complianceFlags;

  // A disqualified prospect stops here. No price, no scope, no proposal — the
  // artifacts themselves are the temptation to sell anyway.
  if (qualification.verdict === 'DISQUALIFY') {
    return {
      offerId: OFFER_ID,
      offerStatement: OFFER_STATEMENT,
      clientRef: ref,
      clientName: client.name || ref,
      proceed: false,
      stage: 'disqualified',
      blockers: qualification.blockers,
      qualification,
      estimatedCosts: costs,
      recommendation: `Do not proceed. ${qualification.blockers[0]}`,
    };
  }

  const pricing = priceFromValue(qualification.opportunity, {
    estimatedDeveloperCost: costs.developerCost,
    estimatedOpsCost: costs.opsCost,
    valueCaptureRate: client.valueCaptureRate,
  });
  const retainer = recommendRetainer(qualification.opportunity);
  const depositRate = client.depositRate === undefined ? DEPOSIT_TARGET : Number(client.depositRate);

  const quoteArgs = {
    projectPrice: pricing.recommendedPrice,
    developerCost: costs.developerCost,
    opsCost: costs.opsCost,
    depositRate,
    opportunity: qualification.opportunity,
  };

  let quote = quotePricing({ ...quoteArgs, monthlyRetainer: retainer.monthlyRetainer });
  let retainerStructure = 'monthly';
  let retainerFallbackNote = null;

  // A smaller client can often afford the build comfortably while a $2k/mo
  // retainer swallows too much of what the system produces. When the build's
  // payback passes but the combined year-one ROI does not, the answer is not to
  // kill the deal — it is to change the support structure. We re-quote with no
  // monthly retainer and recommend a quarterly optimization package instead,
  // priced below three months of the monthly fee.
  const paybackFailed = quote.roi && quote.roi.blockers.some((b) => b.includes('pays back'));
  if (!quote.approved && !paybackFailed) {
    const buildOnly = quotePricing({ ...quoteArgs, monthlyRetainer: 0 });
    if (buildOnly.roi && buildOnly.roi.acceptable) {
      const quarterly = Math.round((retainer.monthlyRetainer * 3 * 0.6) / 250) * 250;
      quote = buildOnly;
      retainerStructure = 'quarterly-optimization';
      retainerFallbackNote = `A $${retainer.monthlyRetainer}/mo retainer is too large a share of the $${Math.round(qualification.opportunity.annualRecoverableValue / 12)}/mo this system produces for ${client.name || ref}. Quote the build alone, plus a $${quarterly}/quarter optimization package. Revisit a monthly retainer once measured recovered revenue supports it.`;
      retainer.monthlyRetainer = 0;
      retainer.quarterlyOptimization = quarterly;
      retainer.structure = retainerStructure;
    }
  }
  retainer.structure = retainer.structure || retainerStructure;

  const deliveryPlan = buildDeliveryPlan({
    clientRef: ref,
    capabilities: capabilities.map((c) => c.id),
    developerBudget: costs.developerCost,
    complianceFlags,
  });

  const cashFlow = checkCashFlow({
    depositAmount: quote.depositAmount,
    balanceAmount: quote.balanceAmount,
    milestones: deliveryPlan.milestones,
  });

  const blockers = [];
  const escalations = [];
  if (pricing.escalateToCustom) escalations.push(pricing.escalationNote);
  if (retainerFallbackNote) escalations.push(retainerFallbackNote);
  if (!quote.approved) blockers.push(...quote.blockers);
  if (pricing.infeasible) blockers.push('Our cost floor exceeds what this client\'s value can carry — the build is too expensive for them at any margin.');
  if (!cashFlow.solvent) blockers.push(cashFlow.warning);

  const proceed = blockers.length === 0 && qualification.verdict === 'PURSUE';
  const stage = qualification.verdict === 'DISCOVERY' ? 'discovery-incomplete' : (proceed ? 'ready-to-propose' : 'blocked');

  // Access summary across the whole engagement — what contractors will and will
  // not hold, in one place, for the client's security questionnaire.
  const tiers = [...new Set(deliveryPlan.tickets.map((t) => t.accessPlan.effectiveTier))];
  const requiredAgreements = [...new Set(deliveryPlan.tickets.flatMap((t) => t.accessPlan.requiredAgreements))];
  const downgradedTickets = deliveryPlan.tickets.filter((t) => t.accessPlan.downgraded).map((t) => t.id);

  return {
    offerId: OFFER_ID,
    offerStatement: OFFER_STATEMENT,
    clientRef: ref,
    clientName: client.name || ref,
    vertical: vertical(client.verticalId),
    proceed,
    stage,
    blockers,
    gaps: qualification.gaps,
    notes: qualification.notes,
    escalations,
    qualification,
    estimatedCosts: costs,
    pricing,
    retainer,
    quote,
    deliveryPlan,
    cashFlow,
    access: {
      tiersInUse: tiers,
      requiredAgreements,
      downgradedTickets,
      neverGranted: deliveryPlan.tickets.length ? deliveryPlan.tickets[0].accessPlan.deniedAlways : [],
      complianceFlags,
      revocationChecklist: revocationChecklist(deliveryPlan.tickets[0] ? deliveryPlan.tickets[0].accessPlan : null),
    },
    economics: {
      projectPrice: quote.projectPrice,
      depositAmount: quote.depositAmount,
      balanceAmount: quote.balanceAmount,
      developerCost: quote.developerCost,
      opsCost: quote.opsCost,
      grossProfit: quote.grossProfit,
      grossMarginPct: quote.grossMarginPct,
      monthlyRetainer: quote.monthlyRetainer,
      yearOneRevenue: quote.yearOneRevenue,
      yearOneGrossProfit: quote.yearOneGrossProfit,
      roi: quote.roi,
    },
    recommendation: proceed
      ? `Proceed. Quote $${quote.projectPrice} with $${quote.depositAmount} (${round(depositRate * 100)}%) upfront ${retainerStructure === 'monthly' ? `plus a $${quote.monthlyRetainer}/mo retainer` : `plus a $${retainer.quarterlyOptimization}/quarter optimization package`}. Gross margin ${quote.grossMarginPct}%; build pays back in ${quote.roi ? quote.roi.paybackMonths : 'n/a'} months.`
      : (qualification.verdict === 'DISCOVERY'
        ? `Do not quote yet. Missing discovery facts: ${qualification.gaps.join('; ')}.`
        : `Blocked: ${blockers.join(' ')}`),
  };
}

module.exports = {
  DEVELOPER_COST_PER_CAPABILITY,
  DEVELOPER_COST_LAUNCH,
  OPS_COST_BASE,
  OPS_COST_PER_CAPABILITY,
  estimateCosts,
  planEngagement,
};

'use strict';

/**
 * Revenue opportunity scanner.
 *
 * Lion Elite already captures several independent revenue signals — gated
 * signups, prior customers due a reorder, people publicly asking for a
 * supplier, funnel stages that leak — and each one lives in its own module with
 * its own CLI. Nothing ranks them against each other, so "what is the single
 * highest-value thing to do right now" has no answer, and the smallest, easiest
 * money goes unnoticed next to the loudest problem.
 *
 * This scans every source, converts each finding into a comparable opportunity
 * with an expected value, and returns one ranked queue.
 *
 * Two properties are deliberate and enforced by tests:
 *
 *   1. Expected value is never invented. A source with no basis for a value
 *      estimate reports `estimable: false` rather than emitting a confident
 *      fake number, because a made-up EV would reorder the whole queue.
 *   2. An opportunity that cannot be acted on automatically is surfaced with
 *      `automatable: false` and the reason. It is never silently upgraded —
 *      some of these are blocked by law (consent) and some by explicit owner
 *      decision (no social engagement), and neither is the scanner's to
 *      override.
 *
 * Pure functions over plain inputs: no database, no network.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Effort weights divide expected value, so a large payoff needing a lot of
 * human work can rank below a small one that is already automated. Relative,
 * not hours.
 */
const EFFORT = Object.freeze({
  automated: 1, // a draft already exists; enabling the send is the only step
  light: 2, // a few minutes of human work per item
  manual: 5, // individual human attention, one at a time
});

const OPPORTUNITY_TYPES = Object.freeze([
  'welcome_consented_lead',
  'reorder_due_customer',
  'inbound_supplier_request',
  'funnel_stage_leak',
]);

const round = (n) => Math.round(n * 100) / 100;
const daysBetween = (from, to) => Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / DAY_MS));

/**
 * One opportunity. `expectedValueCents` is `value * probability` and is null
 * when either input is unknown — callers must handle null rather than treating
 * a missing estimate as zero, which would silently bury real opportunities.
 */
function makeOpportunity({
  id,
  type,
  brand = 'wellness',
  subject,
  valueCents = null,
  probability = null,
  effort = EFFORT.manual,
  automatable = true,
  blockers = [],
  recommendedAction,
  evidence = {},
  ageDays = null,
}) {
  const estimable = valueCents !== null && probability !== null;
  const expectedValueCents = estimable ? Math.round(valueCents * probability) : null;

  // Blocked work is still worth surfacing — it is usually one setting away from
  // being unblocked — but it must not outrank work that can happen today.
  const blocked = blockers.length > 0;
  const score = estimable ? (expectedValueCents / effort) * (blocked ? 0.25 : 1) : 0;

  return {
    id,
    type,
    brand,
    subject,
    valueCents,
    probability,
    expectedValueCents,
    estimable,
    effort,
    automatable,
    blocked,
    blockers,
    recommendedAction,
    evidence,
    ageDays,
    score: round(score),
  };
}

/**
 * Consented signups who have never been contacted. Highest-confidence source in
 * the system: they asked to hear from us.
 */
function scanGatedLeads(analysis, { averageOrderValueCents = null, welcomeConversionRate = null } = {}) {
  if (!analysis || !Array.isArray(analysis.actionableLeads)) return [];

  return analysis.actionableLeads.map((lead) =>
    makeOpportunity({
      id: `lead:${lead.email || lead.id}`,
      type: 'welcome_consented_lead',
      subject: lead.email || lead.name,
      valueCents: averageOrderValueCents,
      probability: welcomeConversionRate,
      // The draft is already built and compliance-checked; only the send switch
      // stands between this and revenue.
      effort: EFFORT.automated,
      automatable: lead.emailReachable,
      blockers: lead.emailReachable ? [] : ['email_not_reachable'],
      recommendedAction: lead.emailReachable
        ? 'send gated_lead_welcome'
        : 'sms follow-up (consented) or leave alone',
      evidence: { source: lead.source, channels: { email: lead.emailReachable, sms: lead.smsReachable } },
      ageDays: lead.ageDays,
    })
  );
}

/** Prior customers past their reorder cooldown. */
function scanReorderCustomers(customers = [], { averageOrderValueCents = null, reorderRate = null, now = new Date() } = {}) {
  return customers.map((customer) => {
    const consented = customer.emailConsent !== false && !customer.suppressed;
    return makeOpportunity({
      id: `reorder:${customer.email || customer.id}`,
      type: 'reorder_due_customer',
      subject: customer.email || customer.id,
      // A prior purchase is the strongest predictor available, so a customer's
      // own last order value beats a catalog-wide average when we have it.
      valueCents: customer.lastOrderValueCents ?? averageOrderValueCents,
      probability: reorderRate,
      effort: EFFORT.automated,
      automatable: consented,
      blockers: consented ? [] : ['no_consent_or_suppressed'],
      recommendedAction: consented ? 'send client_research_reorder' : 'exclude',
      evidence: { lastOrderAt: customer.lastOrderAt || null },
      ageDays: customer.lastOrderAt ? daysBetween(customer.lastOrderAt, now) : null,
    });
  });
}

/**
 * People publicly asking for a supplier. The highest-intent signal available —
 * and the one the scanner must NOT act on.
 *
 * Auto-reply/auto-outreach on social was requested once and explicitly
 * declined: it violates the no-customer-outreach limit, platform guidelines,
 * and RUO marketing rules. `social-listening/` is read-only by design and stays
 * that way. These surface as work for a human to do by hand, and anything the
 * classifier flagged as human-use intent is dropped entirely rather than ranked.
 */
function scanInboundIntent(leads = [], { averageOrderValueCents = null, inboundConversionRate = null, now = new Date() } = {}) {
  return leads
    .filter((lead) => !lead.doNotEngage)
    .map((lead) =>
      makeOpportunity({
        id: `inbound:${lead.did || ''}:${lead.rkey || ''}`,
        type: 'inbound_supplier_request',
        subject: lead.postUrl || lead.postText,
        valueCents: averageOrderValueCents,
        // The classifier's own score modulates confidence rather than being
        // treated as a probability directly.
        probability:
          inboundConversionRate === null ? null : inboundConversionRate * ((lead.score ?? 50) / 100),
        effort: EFFORT.manual,
        automatable: false,
        blockers: ['human_only_no_auto_engagement'],
        recommendedAction: 'reply by hand on bsky.app — automated engagement is not permitted',
        evidence: { niche: lead.niche, score: lead.score, intentSignals: lead.intentSignals || [], postText: lead.postText },
        ageDays: lead.seenAt ? daysBetween(lead.seenAt, now) : null,
      })
    );
}

/**
 * The worst stage-to-stage drop in the funnel. Fixing a leak compounds across
 * every future lead, which is why it is ranked against individual leads at all.
 */
function scanFunnelLeaks(leak, { averageOrderValueCents = null, recoverableShare = 0.2, stageToPurchaseRate = null } = {}) {
  if (!leak || !leak.lost) return [];

  const probability = stageToPurchaseRate === null ? null : stageToPurchaseRate * recoverableShare;
  return [
    makeOpportunity({
      id: `leak:${leak.from}->${leak.to}`,
      type: 'funnel_stage_leak',
      subject: `${leak.from} → ${leak.to}`,
      valueCents: averageOrderValueCents === null ? null : averageOrderValueCents * leak.lost,
      probability,
      effort: EFFORT.light,
      automatable: false,
      blockers: [],
      recommendedAction: `investigate why ${leak.lost} dropped between ${leak.from} and ${leak.to}`,
      evidence: { lost: leak.lost, retainedPct: leak.retainedPct ?? null },
    }),
  ];
}

/**
 * Run every source and rank the combined result.
 *
 * Rate inputs are required for a source to produce an estimate. They are not
 * defaulted: with no measured history, an invented conversion rate would
 * produce a confident ranking built on nothing.
 */
function scanOpportunities(sources = {}, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const opts = { ...options, now };

  const opportunities = [
    ...scanGatedLeads(sources.gatedLeadAnalysis, opts),
    ...scanReorderCustomers(sources.reorderCustomers, opts),
    ...scanInboundIntent(sources.inboundLeads, opts),
    ...scanFunnelLeaks(sources.funnelLeak, opts),
  ];

  const ranked = [...opportunities].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable, meaningful tie-break: the longest-waiting first.
    return (b.ageDays ?? 0) - (a.ageDays ?? 0);
  });

  const actionableNow = ranked.filter((o) => o.automatable && !o.blocked);
  const estimated = ranked.filter((o) => o.estimable);

  const byType = {};
  for (const o of opportunities) {
    const t = (byType[o.type] ||= { count: 0, expectedValueCents: 0, estimable: 0, blocked: 0 });
    t.count += 1;
    if (o.estimable) {
      t.estimable += 1;
      t.expectedValueCents += o.expectedValueCents;
    }
    if (o.blocked) t.blocked += 1;
  }

  return {
    generatedAt: now.toISOString(),
    total: opportunities.length,
    actionableNow: actionableNow.length,
    blocked: ranked.filter((o) => o.blocked).length,
    humanOnly: ranked.filter((o) => !o.automatable).length,
    unestimated: opportunities.length - estimated.length,
    totalExpectedValueCents: estimated.reduce((sum, o) => sum + o.expectedValueCents, 0),
    byType,
    ranked,
    // The single highest-value thing that can actually happen right now, which
    // is not always the highest-value thing overall.
    topAction: actionableNow[0] || null,
    topOverall: ranked[0] || null,
  };
}

module.exports = {
  scanOpportunities,
  scanGatedLeads,
  scanReorderCustomers,
  scanInboundIntent,
  scanFunnelLeaks,
  makeOpportunity,
  EFFORT,
  OPPORTUNITY_TYPES,
};

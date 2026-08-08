'use strict';

/**
 * Bridges the funnel-event store to the Revenue Intelligence Engine (#92).
 *
 * The two halves were built separately and neither is useful alone:
 *
 *   revenue-intelligence/  forecasts, prices the pipeline, detects leaks and
 *                          emits daily actions — but takes its events as a
 *                          function argument and has no source for them.
 *   lib/revenue/           captures, validates and idempotently persists every
 *                          revenue event — but only summarises them.
 *
 * This module is the join: stored funnel events in, the shape
 * normalizeRevenueEvent() expects out. Keeping the translation here rather than
 * changing either side means both remain independently testable, and the
 * intelligence engine stays usable with events from any other source.
 */

const { REVENUE_EVENTS, FUNNEL_STAGES } = require('./funnel-events');

/**
 * Stage-to-close probabilities for pipeline valuation. Deliberately
 * conservative and monotonic: a lead that has only just been created is not
 * worth a meaningful fraction of an order, and nothing short of a completed
 * purchase is worth 1.0.
 */
const STAGE_PROBABILITY = Object.freeze({
  lead_created: 0.02,
  consent_captured: 0.05,
  welcome_email_sent: 0.07,
  reply_received: 0.15,
  qualified: 0.3,
  offer_sent: 0.5,
  coaching_application: 0.35,
});

/**
 * Money events → the intelligence engine's revenue-event shape.
 *
 * `isRepeat` is taken from the event type rather than recomputed, because the
 * taxonomy already distinguishes a first purchase from a repeat one at capture
 * time, when the caller actually knows.
 */
function toRevenueEvents(events = []) {
  return events
    .filter((event) => REVENUE_EVENTS.includes(event.type))
    .map((event) => ({
      id: event.eventKey,
      orderId: event.eventKey,
      timestamp: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
      // The store keeps integer cents; the intelligence engine works in units.
      amount: (event.amountCents || 0) / 100,
      brand: event.brand,
      source: event.source,
      customerId: event.subjectId,
      isRepeat: event.type === 'repeat_purchase',
      verified: true,
    }));
}

/**
 * Open (non-converted) funnel positions → weighted pipeline leads.
 *
 * A subject is represented once, at the furthest stage it reached, so someone
 * who moved lead → qualified is one lead worth 0.3 rather than three leads
 * stacking up. Subjects who already bought are excluded: they are booked
 * revenue, and counting them again would inflate the forecast with money
 * already collected.
 */
function toPipelineLeads(events = [], { averageOrderValue = 0 } = {}) {
  const converted = new Set(
    events.filter((e) => REVENUE_EVENTS.includes(e.type)).map((e) => e.subjectId)
  );

  const furthest = new Map();
  for (const event of events) {
    if (converted.has(event.subjectId)) continue;
    const rank = FUNNEL_STAGES.indexOf(event.type);
    const probability = STAGE_PROBABILITY[event.type];
    if (probability === undefined) continue;

    const existing = furthest.get(event.subjectId);
    // coaching_application is not in FUNNEL_STAGES (rank -1); rank by
    // probability so it still beats an earlier acquisition stage.
    if (!existing || probability > existing.probability || rank > existing.rank) {
      furthest.set(event.subjectId, {
        id: event.subjectId,
        stage: event.type,
        rank,
        probability,
        brand: event.brand,
        source: event.source,
        value: averageOrderValue,
        stageProbability: probability,
      });
    }
  }

  return [...furthest.values()].map(({ rank, probability, ...lead }) => lead);
}

/** Everything the intelligence engine needs, derived from stored events. */
function toIntelligenceInput(events = [], { monthlyTarget, now, averageOrderValue } = {}) {
  const revenueEvents = toRevenueEvents(events);
  const aov =
    averageOrderValue ??
    (revenueEvents.length
      ? revenueEvents.reduce((sum, e) => sum + e.amount, 0) / revenueEvents.length
      : 0);

  return {
    revenueEvents,
    leads: toPipelineLeads(events, { averageOrderValue: aov }),
    ...(monthlyTarget ? { monthlyTarget } : {}),
    ...(now ? { now } : {}),
  };
}

module.exports = { toRevenueEvents, toPipelineLeads, toIntelligenceInput, STAGE_PROBABILITY };

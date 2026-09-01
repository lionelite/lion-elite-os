'use strict';

/**
 * Daily executive report over funnel events (Issue #89, P1).
 *
 * Answers three questions the owner actually asks: how much came in, where did
 * it come from, and which step is leaking. Grouped by brand and by source.
 *
 * Pure aggregation over an array of events — no database — so the maths is
 * unit-testable and the same function serves the CLI, the cron job, and any
 * future dashboard.
 */

const {
  BRANDS,
  FUNNEL_STAGES,
  COACHING_STAGES,
  REVENUE_EVENTS,
  KNOWN_SOURCES,
} = require('./funnel-events');

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

const pct = (numerator, denominator) =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;

const emptyStageCounts = (stages) => Object.fromEntries(stages.map((s) => [s, 0]));

/**
 * Walk the ordered funnel and report each step's conversion from the step
 * before it. Uses the previous *non-zero* stage as the denominator: if nothing
 * ever reached `qualified`, reporting "0% of 0" for every later stage hides
 * where the pipeline actually stopped.
 */
function stageConversions(counts) {
  const rows = [];
  let previousStage = null;
  for (const stage of FUNNEL_STAGES) {
    const count = counts[stage] || 0;
    rows.push({
      stage,
      count,
      fromPrevious: previousStage ? pct(count, counts[previousStage]) : null,
      previousStage,
    });
    if (count > 0) previousStage = stage;
  }
  return rows;
}

/**
 * The single most useful line in the report: the adjacent stage pair that loses
 * the most people in absolute terms. Percentage alone misleads — a 90% drop on
 * 3 leads matters less than a 40% drop on 400.
 */
function biggestDropOff(counts) {
  let worst = null;
  let previousStage = null;
  for (const stage of FUNNEL_STAGES) {
    const count = counts[stage] || 0;
    if (previousStage) {
      const lost = (counts[previousStage] || 0) - count;
      if (lost > 0 && (!worst || lost > worst.lost)) {
        worst = {
          from: previousStage,
          to: stage,
          lost,
          retainedPct: pct(count, counts[previousStage]),
        };
      }
    }
    if (count > 0) previousStage = stage;
  }
  return worst;
}

function summarize(events) {
  const counts = { ...emptyStageCounts(FUNNEL_STAGES), ...emptyStageCounts(COACHING_STAGES) };
  let revenueCents = 0;
  let newRevenueCents = 0;
  let repeatRevenueCents = 0;
  let coachingRevenueCents = 0;
  const payingSubjects = new Set();

  for (const event of events) {
    if (counts[event.type] === undefined) continue;
    counts[event.type] += 1;

    if (REVENUE_EVENTS.includes(event.type)) {
      const amount = event.amountCents || 0;
      revenueCents += amount;
      payingSubjects.add(event.subjectId);
      if (event.type === 'purchase_completed') newRevenueCents += amount;
      if (event.type === 'repeat_purchase') repeatRevenueCents += amount;
      if (event.type === 'coaching_close') coachingRevenueCents += amount;
    }
  }

  const orders = counts.purchase_completed + counts.repeat_purchase;

  return {
    counts,
    revenueCents,
    newRevenueCents,
    repeatRevenueCents,
    coachingRevenueCents,
    orders,
    payingCustomers: payingSubjects.size,
    averageOrderValueCents: orders > 0 ? Math.round((newRevenueCents + repeatRevenueCents) / orders) : 0,
    leadToPurchasePct: pct(counts.purchase_completed, counts.lead_created),
    coachingApplicationToClosePct: pct(counts.coaching_close, counts.coaching_application),
    stages: stageConversions(counts),
    biggestDropOff: biggestDropOff(counts),
  };
}

function groupBy(events, key) {
  const groups = new Map();
  for (const event of events) {
    const value = event[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(event);
  }
  return groups;
}

/**
 * Build the full report. `events` should already be filtered to the reporting
 * window by the caller (the store does this in SQL).
 */
function buildReport({ events = [], date = new Date(), windowDays = 1 } = {}) {
  const overall = summarize(events);

  const byBrand = {};
  const brandGroups = groupBy(events, 'brand');
  for (const brand of BRANDS) {
    const brandEvents = brandGroups.get(brand) || [];
    const brandSummary = summarize(brandEvents);
    const sources = {};
    for (const [source, sourceEvents] of groupBy(brandEvents, 'source')) {
      sources[source] = summarize(sourceEvents);
    }
    byBrand[brand] = { ...brandSummary, sources };
  }

  const bySource = {};
  for (const [source, sourceEvents] of groupBy(events, 'source')) {
    bySource[source] = summarize(sourceEvents);
  }

  return {
    generatedAt: new Date().toISOString(),
    date: new Date(date).toISOString().slice(0, 10),
    windowDays,
    eventCount: events.length,
    overall,
    byBrand,
    bySource,
  };
}

const stageLabel = (s) => s.replace(/_/g, ' ');

/** Human-readable rendering for the cron log, an email, or a terminal. */
function renderReport(report) {
  const lines = [];
  const o = report.overall;

  lines.push(`LION ELITE — REVENUE REPORT  ${report.date}  (${report.windowDays}d window)`);
  lines.push('='.repeat(64));

  if (report.eventCount === 0) {
    lines.push('');
    lines.push('No funnel events recorded in this window.');
    lines.push('');
    lines.push('This is a real signal, not an empty report: either nothing is being');
    lines.push('instrumented yet, or the pipeline produced nothing. Check that the');
    lines.push('emitters are wired before treating a quiet day as a slow day.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Revenue        ${money(o.revenueCents)}   (new ${money(o.newRevenueCents)} · repeat ${money(o.repeatRevenueCents)} · coaching ${money(o.coachingRevenueCents)})`);
  lines.push(`Orders         ${o.orders}   ·   paying customers ${o.payingCustomers}   ·   AOV ${money(o.averageOrderValueCents)}`);
  if (o.leadToPurchasePct !== null) lines.push(`Lead→purchase  ${o.leadToPurchasePct}%`);
  if (o.coachingApplicationToClosePct !== null) {
    lines.push(`Coaching app→close  ${o.coachingApplicationToClosePct}%  (${o.counts.coaching_close}/${o.counts.coaching_application})`);
  }

  lines.push('');
  lines.push('FUNNEL');
  for (const row of o.stages) {
    const conv = row.fromPrevious === null ? '' : `  ${row.fromPrevious}% of ${stageLabel(row.previousStage)}`;
    lines.push(`  ${stageLabel(row.stage).padEnd(20)} ${String(row.count).padStart(6)}${conv}`);
  }

  if (o.biggestDropOff) {
    const d = o.biggestDropOff;
    lines.push('');
    lines.push(`BIGGEST LEAK   ${stageLabel(d.from)} → ${stageLabel(d.to)}: lost ${d.lost} (${d.retainedPct}% retained)`);
  }

  lines.push('');
  lines.push('BY BRAND');
  for (const brand of BRANDS) {
    const b = report.byBrand[brand];
    if (!b || b.counts.lead_created === 0 && b.revenueCents === 0 && b.counts.coaching_application === 0) {
      lines.push(`  ${brand.padEnd(18)} —  no activity`);
      continue;
    }
    lines.push(`  ${brand.padEnd(18)} ${money(b.revenueCents).padStart(11)}  ${b.orders} orders  ${b.counts.lead_created} leads`);
    const sources = Object.entries(b.sources).sort((x, y) => y[1].revenueCents - x[1].revenueCents);
    for (const [source, s] of sources) {
      lines.push(`      ${source.padEnd(16)} ${money(s.revenueCents).padStart(11)}  ${s.orders} orders  ${s.counts.lead_created} leads`);
    }
  }

  lines.push('');
  lines.push('BY SOURCE (all brands)');
  const ranked = Object.entries(report.bySource).sort((a, b) => b[1].revenueCents - a[1].revenueCents);
  for (const [source, s] of ranked) {
    const conv = s.leadToPurchasePct === null ? '' : `  ${s.leadToPurchasePct}% lead→purchase`;
    lines.push(`  ${source.padEnd(18)} ${money(s.revenueCents).padStart(11)}  ${s.orders} orders${conv}`);
  }

  return lines.join('\n');
}

module.exports = {
  buildReport,
  renderReport,
  summarize,
  stageConversions,
  biggestDropOff,
  money,
  pct,
  KNOWN_SOURCES,
};

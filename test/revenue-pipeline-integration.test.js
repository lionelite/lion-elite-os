'use strict';

/**
 * Integration test across the two halves of the revenue engine.
 *
 * lib/revenue captures and validates events; revenue-intelligence (#92)
 * forecasts and detects leaks but has no source of events. This proves the
 * adapter joins them and that money survives the trip intact — the failure
 * mode that matters is a units mismatch (cents vs dollars) silently reporting
 * revenue 100x off.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEvent } = require('../lib/revenue/funnel-events');
const { toRevenueEvents, toPipelineLeads, toIntelligenceInput } = require('../lib/revenue/intelligence-adapter');
const { generateExecutiveReport, calculateRevenueSummary } = require('../revenue-intelligence');

const at = (day, hour = 12) => new Date(Date.UTC(2026, 7, day, hour, 0, 0)).toISOString();

const ev = (type, brand, source, subjectId, amountCents, day = 4) =>
  buildEvent({ type, brand, source, subjectId, amountCents, occurredAt: at(day) });

test('money survives the handoff: cents in the store become units in the engine', () => {
  const events = [ev('purchase_completed', 'wellness', 'organic', 'c1', 14999)];
  const [revenueEvent] = toRevenueEvents(events);

  assert.equal(revenueEvent.amount, 149.99, 'a 100x units error here would silently misreport revenue');
  assert.equal(revenueEvent.brand, 'wellness');
  assert.equal(revenueEvent.source, 'organic');
  assert.equal(revenueEvent.customerId, 'c1');
  assert.equal(revenueEvent.verified, true);
});

test('repeat purchases are carried through, not recomputed', () => {
  const events = [
    ev('purchase_completed', 'wellness', 'organic', 'c1', 10000),
    ev('repeat_purchase', 'wellness', 'organic', 'c1', 5000, 5),
  ];
  const mapped = toRevenueEvents(events);

  assert.equal(mapped.length, 2);
  assert.equal(mapped.find((e) => e.amount === 100).isRepeat, false);
  assert.equal(mapped.find((e) => e.amount === 50).isRepeat, true);
});

test('non-revenue funnel events never become revenue', () => {
  const events = [
    ev('lead_created', 'wellness', 'organic', 'c1'),
    ev('qualified', 'wellness', 'organic', 'c1'),
    ev('offer_sent', 'wellness', 'organic', 'c1'),
  ];
  assert.deepEqual(toRevenueEvents(events), [], 'an offer is not money');
});

test('a subject is priced once, at the furthest stage reached', () => {
  const events = [
    ev('lead_created', 'wellness', 'organic', 'c1'),
    ev('consent_captured', 'wellness', 'organic', 'c1'),
    ev('qualified', 'wellness', 'organic', 'c1'),
  ];
  const leads = toPipelineLeads(events, { averageOrderValue: 100 });

  assert.equal(leads.length, 1, 'one person moving through stages is one lead, not three');
  assert.equal(leads[0].stage, 'qualified');
  assert.equal(leads[0].stageProbability, 0.3);
});

test('converted subjects are excluded from the pipeline', () => {
  // Otherwise the forecast double-counts money already collected.
  const events = [
    ev('lead_created', 'wellness', 'organic', 'buyer'),
    ev('qualified', 'wellness', 'organic', 'buyer'),
    ev('purchase_completed', 'wellness', 'organic', 'buyer', 14999, 5),
    ev('lead_created', 'wellness', 'organic', 'still-open'),
  ];
  const leads = toPipelineLeads(events, { averageOrderValue: 149.99 });

  assert.equal(leads.length, 1);
  assert.equal(leads[0].id, 'still-open');
});

test('stored events drive a full executive report end to end', () => {
  const events = [
    ev('lead_created', 'wellness', 'organic', 'c1'),
    ev('qualified', 'wellness', 'organic', 'c1'),
    ev('purchase_completed', 'wellness', 'organic', 'c1', 14999, 5),
    ev('purchase_completed', 'wellness', 'affiliate', 'c2', 8999, 5),
    ev('repeat_purchase', 'wellness', 'organic', 'c3', 10999, 6),
    ev('coaching_close', 'beauty', 'social_organic', 'b1', 240000, 6),
    ev('lead_created', 'beauty', 'paid_meta', 'b2'),
    ev('consent_captured', 'beauty', 'paid_meta', 'b2'),
  ];

  const input = toIntelligenceInput(events, { monthlyTarget: 100000, now: new Date(at(7)) });
  const report = generateExecutiveReport(input);

  // 149.99 + 89.99 + 109.99 + 2400.00. The engine reports month-to-date, and
  // every event above falls in the same month as `now`.
  const expected = 149.99 + 89.99 + 109.99 + 2400;
  assert.equal(report.revenue.revenueMTD, Math.round((expected + Number.EPSILON) * 100) / 100);
  assert.equal(report.revenue.ordersMTD, 4);
  assert.equal(report.revenue.repeatRevenue, 109.99, 'repeat revenue must be split out');
  assert.equal(report.revenue.byBrand.beauty, 2400, 'coaching revenue lands under beauty');
  assert.equal(report.revenue.attributionCoveragePct, 100, 'every event carried a known source');

  assert.ok(report.pipeline, 'pipeline must be valued from the open leads');
  assert.ok(Array.isArray(report.dailyActions));
  assert.ok(Array.isArray(report.topRevenueLeaks));
  assert.equal(report.objective, 'Revenue every day');
  // The engine's compliance guardrails must survive the integration.
  assert.match(report.compliance.lionEliteWellness, /[Rr]esearch-use-only/);
});

test('an empty store produces a zero report rather than throwing', () => {
  const report = generateExecutiveReport(toIntelligenceInput([]));
  assert.equal(report.revenue.revenueMTD, 0);
  assert.equal(report.revenue.ordersMTD, 0);
});

test('the adapter derives AOV from real orders when none is supplied', () => {
  const events = [
    ev('purchase_completed', 'wellness', 'organic', 'c1', 10000),
    ev('purchase_completed', 'wellness', 'organic', 'c2', 20000),
    ev('lead_created', 'wellness', 'organic', 'open1'),
  ];
  const input = toIntelligenceInput(events);
  const openLead = input.leads.find((l) => l.id === 'open1');

  assert.equal(openLead.value, 150, 'AOV of a $100 and a $200 order is $150');
});

test('the summary agrees with the engine on totals', () => {
  const events = [
    ev('purchase_completed', 'wellness', 'organic', 'c1', 14999),
    ev('repeat_purchase', 'wellness', 'organic', 'c1', 5000, 5),
  ];
  const summary = calculateRevenueSummary(toRevenueEvents(events), { now: new Date(at(7)) });
  assert.equal(summary.revenueMTD, 199.99);
  assert.equal(summary.repeatRevenue, 50);
});

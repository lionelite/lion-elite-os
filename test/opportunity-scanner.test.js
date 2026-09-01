'use strict';

/**
 * Revenue opportunity scanner tests.
 *
 * The scanner's whole job is deciding what to do first, so the rules under test
 * are the ones that could put the wrong thing at the top: inventing a value,
 * ranking blocked work above work that can happen today, or promoting something
 * the owner or the law says must stay manual.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scanOpportunities,
  scanGatedLeads,
  scanReorderCustomers,
  scanInboundIntent,
  scanFunnelLeaks,
  EFFORT,
} = require('../lib/revenue/opportunity-scanner');
const { analyzeLeads } = require('../lib/leads/lead-analyzer');

const NOW = new Date('2026-08-10T12:00:00.000Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

const RATES = {
  averageOrderValueCents: 10000,
  welcomeConversionRate: 0.1,
  reorderRate: 0.2,
  inboundConversionRate: 0.1,
  stageToPurchaseRate: 0.1,
  now: NOW,
};

// ── value is never invented ─────────────────────────────────────────────────

test('with no rates supplied, opportunities are listed but not valued', () => {
  const analysis = analyzeLeads(
    [{ name: 'A', email: 'a@example.com', phone: '+12165550100', email_marketing_consent: 1, created_at: daysAgo(5) }],
    { now: NOW }
  );
  const scan = scanOpportunities({ gatedLeadAnalysis: analysis }, { now: NOW });

  assert.equal(scan.total, 1);
  assert.equal(scan.unestimated, 1);
  assert.equal(scan.ranked[0].expectedValueCents, null, 'a missing rate must not become a confident number');
  assert.equal(scan.ranked[0].estimable, false);
  assert.equal(scan.totalExpectedValueCents, 0);
});

test('expected value is value times probability, in whole cents', () => {
  const [opp] = scanReorderCustomers(
    [{ email: 'x@example.com', lastOrderValueCents: 14999, emailConsent: true, lastOrderAt: daysAgo(60) }],
    RATES
  );
  assert.equal(opp.valueCents, 14999);
  assert.equal(opp.probability, 0.2);
  assert.equal(opp.expectedValueCents, 3000, '14999 * 0.2 rounded');
});

test("a customer's own last order value beats the catalog average", () => {
  const [withHistory] = scanReorderCustomers(
    [{ email: 'a@example.com', lastOrderValueCents: 50000, emailConsent: true }],
    RATES
  );
  const [withoutHistory] = scanReorderCustomers([{ email: 'b@example.com', emailConsent: true }], RATES);
  assert.equal(withHistory.valueCents, 50000);
  assert.equal(withoutHistory.valueCents, RATES.averageOrderValueCents);
});

// ── consent and owner decisions are not overridable ─────────────────────────

test('a non-consenting reorder customer is blocked, however valuable', () => {
  const [opp] = scanReorderCustomers(
    [{ email: 'optout@example.com', lastOrderValueCents: 100000, emailConsent: false }],
    RATES
  );
  assert.equal(opp.blocked, true);
  assert.equal(opp.automatable, false);
  assert.ok(opp.blockers.includes('no_consent_or_suppressed'));
  assert.equal(opp.recommendedAction, 'exclude');
});

test('inbound social requests are never automatable', () => {
  // Auto-engagement on social was explicitly declined; the scanner must not
  // quietly reintroduce it as an "optimisation".
  const [opp] = scanInboundIntent(
    [{ did: 'd', rkey: 'r', score: 90, postUrl: 'https://bsky.app/x', seenAt: daysAgo(2) }],
    RATES
  );
  assert.equal(opp.automatable, false);
  assert.ok(opp.blockers.includes('human_only_no_auto_engagement'));
  assert.match(opp.recommendedAction, /by hand/);
  assert.equal(opp.effort, EFFORT.manual);
});

test('posts flagged do-not-engage are dropped entirely, not merely ranked low', () => {
  const opps = scanInboundIntent(
    [
      { did: 'a', rkey: '1', score: 99, doNotEngage: true },
      { did: 'b', rkey: '2', score: 40, doNotEngage: false },
    ],
    RATES
  );
  assert.equal(opps.length, 1);
  assert.equal(opps[0].id, 'inbound:b:2');
});

test('a lead that is not email-reachable is not proposed for the welcome send', () => {
  const analysis = analyzeLeads(
    [{ name: 'No Consent', email: 'nc@example.com', phone: '+12165550100', email_marketing_consent: 0, sms_marketing_consent: 1, created_at: daysAgo(30) }],
    { now: NOW }
  );
  const opps = scanGatedLeads(analysis, RATES);
  assert.equal(opps.length, 1);
  assert.equal(opps[0].automatable, false);
  assert.notEqual(opps[0].recommendedAction, 'send gated_lead_welcome');
});

// ── ranking ─────────────────────────────────────────────────────────────────

test('blocked work never outranks equivalent work that can happen today', () => {
  const scan = scanOpportunities(
    {
      reorderCustomers: [
        { email: 'blocked@example.com', lastOrderValueCents: 20000, emailConsent: false },
        { email: 'ready@example.com', lastOrderValueCents: 20000, emailConsent: true },
      ],
    },
    RATES
  );
  assert.equal(scan.ranked[0].subject, 'ready@example.com');
  assert.equal(scan.topAction.subject, 'ready@example.com');
});

test('effort discounts value, so cheap automated work can beat costly manual work', () => {
  const scan = scanOpportunities(
    {
      reorderCustomers: [{ email: 'auto@example.com', lastOrderValueCents: 12000, emailConsent: true }],
      inboundLeads: [{ did: 'd', rkey: 'r', score: 100, postUrl: 'https://bsky.app/x' }],
    },
    RATES
  );
  // 12000*0.2/1 = 2400  vs  10000*0.1/5 = 200
  assert.equal(scan.ranked[0].subject, 'auto@example.com');
});

test('topAction is actionable even when topOverall is not', () => {
  const scan = scanOpportunities(
    {
      // Highest raw value, but human-only.
      inboundLeads: [{ did: 'd', rkey: 'r', score: 100, postUrl: 'https://bsky.app/huge' }],
      reorderCustomers: [{ email: 'small@example.com', lastOrderValueCents: 1000, emailConsent: true }],
    },
    { ...RATES, averageOrderValueCents: 500000 }
  );

  assert.equal(scan.topAction.subject, 'small@example.com', 'topAction must be something we can actually do');
  assert.equal(scan.topAction.automatable, true);
  assert.equal(scan.topAction.blocked, false);
});

test('when nothing is actionable, topAction is null rather than a blocked item', () => {
  const scan = scanOpportunities(
    { inboundLeads: [{ did: 'd', rkey: 'r', score: 80, postUrl: 'https://bsky.app/x' }] },
    RATES
  );
  assert.equal(scan.topAction, null);
  assert.ok(scan.topOverall, 'the opportunity is still reported');
});

test('among equally scored items the longest-waiting comes first', () => {
  const analysis = analyzeLeads(
    [
      { name: 'Fresh', email: 'fresh@example.com', phone: '+12165550100', email_marketing_consent: 1, created_at: daysAgo(2) },
      { name: 'Stale', email: 'stale@example.com', phone: '+12165550101', email_marketing_consent: 1, created_at: daysAgo(60) },
    ],
    { now: NOW }
  );
  const scan = scanOpportunities({ gatedLeadAnalysis: analysis }, RATES);
  assert.equal(scan.ranked[0].subject, 'stale@example.com');
});

// ── aggregate reporting ─────────────────────────────────────────────────────

test('a funnel leak is valued across everyone lost, not per person', () => {
  const [opp] = scanFunnelLeaks({ from: 'a', to: 'b', lost: 20, retainedPct: 50 }, RATES);
  assert.equal(opp.valueCents, 200000, '20 lost * $100 average order');
  assert.equal(opp.type, 'funnel_stage_leak');
});

test('an absent source contributes nothing rather than throwing', () => {
  const scan = scanOpportunities({}, RATES);
  assert.equal(scan.total, 0);
  assert.equal(scan.topAction, null);
  assert.equal(scan.totalExpectedValueCents, 0);
});

test('totals count estimated value only, and report how many were unvalued', () => {
  const scan = scanOpportunities(
    {
      reorderCustomers: [{ email: 'valued@example.com', lastOrderValueCents: 10000, emailConsent: true }],
    },
    { now: NOW, reorderRate: 0.5 } // no averageOrderValueCents, but this one has its own
  );
  assert.equal(scan.totalExpectedValueCents, 5000);
  assert.equal(scan.unestimated, 0);
});

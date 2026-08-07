'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEvent,
  subjectHash,
  FUNNEL_STAGES,
  BRANDS,
  FunnelEventError,
} = require('../lib/revenue/funnel-events');
const {
  buildReport,
  renderReport,
  summarize,
  stageConversions,
  biggestDropOff,
} = require('../lib/revenue/executive-report');

const base = {
  type: 'lead_created',
  brand: 'wellness',
  source: 'organic',
  subjectId: 'subject-1',
  occurredAt: '2026-08-04T12:00:00.000Z',
};

// ── taxonomy is closed ──────────────────────────────────────────────────────

test('rejects an unknown event type rather than inventing a funnel stage', () => {
  assert.throws(
    () => buildEvent({ ...base, type: 'lead_creted' }),
    (e) => e instanceof FunnelEventError && e.code === 'UNKNOWN_EVENT_TYPE'
  );
});

test('rejects an unknown brand', () => {
  assert.throws(
    () => buildEvent({ ...base, brand: 'wellnes' }),
    (e) => e.code === 'UNKNOWN_BRAND'
  );
});

test('requires a subjectId', () => {
  assert.throws(() => buildEvent({ ...base, subjectId: '  ' }), (e) => e.code === 'MISSING_SUBJECT');
});

test('normalizes an unrecognised source to unknown instead of dropping the event', () => {
  // Losing a conversion because an ad platform invented a new utm value would be
  // worse than reporting it unattributed.
  const event = buildEvent({ ...base, source: 'utm_some_new_thing' });
  assert.equal(event.source, 'unknown');
});

// ── money ───────────────────────────────────────────────────────────────────

test('revenue events must carry an amount', () => {
  for (const type of ['purchase_completed', 'repeat_purchase', 'coaching_close']) {
    assert.throws(
      () => buildEvent({ ...base, type, brand: type === 'coaching_close' ? 'beauty' : 'wellness' }),
      (e) => e.code === 'MISSING_AMOUNT',
      `${type} should require amountCents`
    );
  }
});

test('rejects fractional and negative amounts', () => {
  assert.throws(() => buildEvent({ ...base, type: 'purchase_completed', amountCents: 149.99 }), (e) => e.code === 'INVALID_AMOUNT');
  assert.throws(() => buildEvent({ ...base, type: 'purchase_completed', amountCents: -1 }), (e) => e.code === 'INVALID_AMOUNT');
});

// ── PII stays out ───────────────────────────────────────────────────────────

test('rejects PII smuggled into metadata', () => {
  for (const key of ['email', 'customer_email', 'phone', 'first_name', 'shipping_address', 'ip']) {
    assert.throws(
      () => buildEvent({ ...base, metadata: { [key]: 'x' } }),
      (e) => e.code === 'PII_IN_METADATA',
      `metadata.${key} should be rejected`
    );
  }
});

test('subjectHash is salted and never returns the raw value', () => {
  const salted = subjectHash('Person@Example.com', { salt: 's1' });
  const other = subjectHash('Person@Example.com', { salt: 's2' });
  assert.notEqual(salted, other, 'different salts must produce different hashes');
  assert.doesNotMatch(salted, /person@example\.com/i);
  // case/whitespace-insensitive so the same person hashes consistently
  assert.equal(salted, subjectHash('  person@example.com ', { salt: 's1' }));
  assert.equal(subjectHash(''), null);
});

// ── idempotency ─────────────────────────────────────────────────────────────

test('the same logical event derives the same key so retries cannot double-count', () => {
  const a = buildEvent({ ...base, type: 'purchase_completed', amountCents: 14999 });
  const b = buildEvent({ ...base, type: 'purchase_completed', amountCents: 14999 });
  assert.equal(a.eventKey, b.eventKey);

  const different = buildEvent({ ...base, type: 'purchase_completed', amountCents: 15000 });
  assert.notEqual(a.eventKey, different.eventKey, 'a different amount is a different event');
});

test('an explicit eventKey wins over the derived one', () => {
  const event = buildEvent({ ...base, eventKey: 'stripe_pi_123' });
  assert.equal(event.eventKey, 'stripe_pi_123');
});

// ── funnel maths ────────────────────────────────────────────────────────────

const evt = (type, brand, source, subjectId, amountCents) =>
  buildEvent({ type, brand, source, subjectId, amountCents, occurredAt: base.occurredAt });

test('summarize splits new, repeat and coaching revenue and dedupes customers', () => {
  const events = [
    evt('purchase_completed', 'wellness', 'organic', 's1', 10000),
    evt('repeat_purchase', 'wellness', 'organic', 's1', 5000),
    evt('coaching_close', 'beauty', 'referral', 's2', 240000),
  ];
  const s = summarize(events);

  assert.equal(s.revenueCents, 255000);
  assert.equal(s.newRevenueCents, 10000);
  assert.equal(s.repeatRevenueCents, 5000);
  assert.equal(s.coachingRevenueCents, 240000);
  assert.equal(s.orders, 2, 'coaching_close is revenue but not a product order');
  assert.equal(s.payingCustomers, 2, 's1 bought twice but is one customer');
  assert.equal(s.averageOrderValueCents, 7500, 'AOV excludes coaching revenue');
});

test('conversion uses the previous non-zero stage, so a dead stage does not hide the stall', () => {
  const counts = Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0]));
  counts.lead_created = 100;
  counts.consent_captured = 50;
  counts.welcome_email_sent = 0; // emitter never wired
  counts.reply_received = 10;

  const rows = stageConversions(counts);
  const reply = rows.find((r) => r.stage === 'reply_received');
  assert.equal(reply.previousStage, 'consent_captured');
  assert.equal(reply.fromPrevious, 20, '10 of 50, not a divide-by-zero against the empty stage');
});

test('biggest leak is measured in people lost, not percentage', () => {
  const counts = Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0]));
  counts.lead_created = 1000;
  counts.consent_captured = 600;   // lost 400
  counts.welcome_email_sent = 590;
  counts.reply_received = 10;      // lost 580 — bigger in absolute terms
  counts.qualified = 1;            // 90% drop but only 9 people

  const worst = biggestDropOff(counts);
  assert.equal(worst.from, 'welcome_email_sent');
  assert.equal(worst.to, 'reply_received');
  assert.equal(worst.lost, 580);
});

test('report groups by brand and source and keeps silent brands visible', () => {
  const events = [
    evt('lead_created', 'wellness', 'organic', 'w1'),
    evt('purchase_completed', 'wellness', 'organic', 'w1', 14999),
    evt('lead_created', 'wellness', 'paid_meta', 'p1'),
    evt('lead_created', 'beauty', 'social_organic', 'b1'),
  ];
  const report = buildReport({ events, windowDays: 1 });

  assert.equal(report.eventCount, 4);
  for (const brand of BRANDS) {
    assert.ok(report.byBrand[brand], `${brand} must appear even with no activity`);
  }
  assert.equal(report.byBrand.wellness.revenueCents, 14999);
  assert.equal(report.byBrand.alexthelionlifts.revenueCents, 0);
  assert.equal(report.byBrand.wellness.sources.paid_meta.counts.lead_created, 1);
  assert.equal(report.byBrand.wellness.sources.paid_meta.revenueCents, 0, 'paid spend with no orders must be visible');
  assert.equal(report.bySource.organic.orders, 1);
});

test('an empty window says so loudly instead of rendering a clean zero report', () => {
  const rendered = renderReport(buildReport({ events: [], windowDays: 1 }));
  assert.match(rendered, /No funnel events recorded/);
  assert.match(rendered, /real signal, not an empty report/);
});

'use strict';

/**
 * Emitter tests.
 *
 * These guard the three things that turn real money into a wrong number: the
 * currency conversion, the idempotency key, and the blast radius of a failure.
 * A fake store stands in for Postgres so the logic is testable without a
 * database — which is also the only way this runs in CI, where there is none.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeOrder,
  attributionFrom,
  unitsToCents,
  centsFromCents,
  emitOrder,
  emitCoachingClose,
  emitWelcomeSent,
  previewOrderEvent,
} = require('../lib/revenue/emitters');

/** Minimal in-memory stand-in for lib/revenue/funnel-store. */
function fakeStore({ priorPurchase = false, failOn = null } = {}) {
  const written = [];
  return {
    written,
    async record(input) {
      if (failOn === 'record') throw new Error('database is down');
      const duplicate = written.some((e) => e.eventKey === input.eventKey);
      if (!duplicate) written.push(input);
      return { event: { ...input }, duplicate };
    },
    async hasPriorPurchase() {
      if (failOn === 'hasPriorPurchase') throw new Error('lookup failed');
      return priorPurchase;
    },
  };
}

const shopifyOrder = (over = {}) => ({
  id: 5551234,
  email: 'Buyer@Example.com',
  total_price: '149.99',
  customer: { id: 991, first_name: 'Jordan' },
  line_items: [{ title: 'ARA-290', quantity: 1, price: '149.99' }],
  ...over,
});

const stripeOrder = (over = {}) => ({
  id: 'cs_test_abc123',
  amount_total: 8999,
  customer: 'cus_XYZ',
  customer_details: { email: 'Buyer@Example.com', name: 'Jordan' },
  ...over,
});

// ── currency ────────────────────────────────────────────────────────────────

test('Shopify units and Stripe cents both land on the same amount', () => {
  // Shopify sends "149.99"; Stripe sends 14999. Both must mean $149.99.
  assert.equal(describeOrder('shopify', shopifyOrder()).amountCents, 14999);
  assert.equal(describeOrder('stripe', stripeOrder({ amount_total: 14999 })).amountCents, 14999);
});

test('unit conversion rounds rather than drifting on floats', () => {
  assert.equal(unitsToCents('0.07'), 7);
  assert.equal(unitsToCents('1.005'), 101, 'rounds, never truncates toward a lost cent');
  assert.equal(unitsToCents('149.99'), 14999);
});

test('unusable amounts are rejected, not coerced to zero', () => {
  for (const bad of [null, undefined, '', 'free', -1]) {
    assert.equal(unitsToCents(bad), null, `${JSON.stringify(bad)} must not become 0`);
  }
  assert.equal(centsFromCents(1.5), null, 'cents must be a whole number');
});

test('a payload with no usable amount is skipped, not recorded as a $0 sale', () => {
  // A $0 purchase would drag average order value down and look like real data.
  assert.equal(describeOrder('shopify', shopifyOrder({ total_price: null })), null);
  assert.equal(describeOrder('stripe', stripeOrder({ amount_total: null, amount: null })), null);
});

test('a payload with no identity is skipped', () => {
  assert.equal(describeOrder('shopify', shopifyOrder({ customer: {}, email: '' })), null);
  assert.equal(describeOrder('stripe', stripeOrder({ customer: null, customer_details: {} })), null);
});

test('an unknown provider yields nothing rather than a malformed event', () => {
  assert.equal(describeOrder('gmail', { id: 1, total_price: '10.00' }), null);
});

// ── identity and PII ────────────────────────────────────────────────────────

test('subject ids are opaque and case-stable, and no raw email is stored', () => {
  const a = describeOrder('shopify', shopifyOrder({ customer: {}, email: 'Buyer@Example.com' }));
  const b = describeOrder('shopify', shopifyOrder({ customer: {}, email: 'buyer@example.com' }));
  assert.equal(a.subjectId, b.subjectId, 'the same person must not become two subjects');

  const event = previewOrderEvent('shopify', shopifyOrder());
  assert.doesNotMatch(JSON.stringify(event.metadata), /example\.com/i);
  assert.equal(event.subjectHash.length, 64, 'the email is hashed, never stored raw');
});

// ── idempotency ─────────────────────────────────────────────────────────────

test('the event key is the provider order id, so retries cannot double-count', async () => {
  const store = fakeStore();
  const args = { source: 'shopify', payload: shopifyOrder(), brandKey: 'wellness', store };

  const first = await emitOrder(args);
  const retry = await emitOrder(args);

  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true, 'a redelivered webhook must be recognised');
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0].eventKey, 'shopify:order:5551234');
});

test('two genuinely different orders are both recorded', async () => {
  const store = fakeStore();
  await emitOrder({ source: 'shopify', payload: shopifyOrder({ id: 1 }), store });
  await emitOrder({ source: 'shopify', payload: shopifyOrder({ id: 2 }), store });
  assert.equal(store.written.length, 2);
});

// ── first vs repeat ─────────────────────────────────────────────────────────

test('a returning customer is recorded as a repeat purchase', async () => {
  const store = fakeStore({ priorPurchase: true });
  const result = await emitOrder({ source: 'shopify', payload: shopifyOrder(), store });
  assert.equal(result.type, 'repeat_purchase');
});

test('a first-time buyer is a purchase, not a repeat', async () => {
  const store = fakeStore({ priorPurchase: false });
  const result = await emitOrder({ source: 'shopify', payload: shopifyOrder(), store });
  assert.equal(result.type, 'purchase_completed');
});

test('when the prior-purchase lookup fails, it falls back to a first purchase', async () => {
  // Inventing a repeat would inflate the repeat-revenue line; the reverse is
  // merely conservative.
  const store = fakeStore({ failOn: 'hasPriorPurchase' });
  const result = await emitOrder({ source: 'shopify', payload: shopifyOrder(), store });
  assert.equal(result.emitted, true);
  assert.equal(result.type, 'purchase_completed');
});

// ── blast radius ────────────────────────────────────────────────────────────

test('a database failure is reported, never thrown at the order pipeline', async () => {
  const store = fakeStore({ failOn: 'record' });
  const result = await emitOrder({ source: 'shopify', payload: shopifyOrder(), store });
  assert.equal(result.emitted, false);
  assert.equal(result.reason, 'error');
  assert.match(result.message, /database is down/);
});

test('every emitter returns a status instead of rejecting', async () => {
  const store = fakeStore({ failOn: 'record' });
  for (const call of [
    emitOrder({ source: 'shopify', payload: shopifyOrder(), store }),
    emitCoachingClose({ subscription: { subscriptionId: 'sub_1', amountCents: 240000 }, store }),
    emitWelcomeSent({ subjectId: 's1', messageId: 'm1', store }),
  ]) {
    const result = await call;
    assert.equal(result.emitted, false, 'a failure must resolve, not reject');
  }
});

// ── attribution ─────────────────────────────────────────────────────────────

test('attribution maps the platforms we actually buy on', () => {
  assert.equal(attributionFrom({ source_name: 'facebook_ads' }), 'paid_meta');
  assert.equal(attributionFrom({ utm_source: 'google' }), 'paid_google');
  assert.equal(attributionFrom({ referring_site: 'https://tiktok.com/x' }), 'paid_tiktok');
  assert.equal(attributionFrom({ source_name: 'my-affiliate-partner' }), 'affiliate');
  assert.equal(attributionFrom({ source_name: 'web' }), 'direct');
  assert.equal(attributionFrom({}), 'direct');
});

test('an unrecognised source still produces a valid event', () => {
  // It normalises to 'unknown' downstream — losing the sale would be worse.
  const event = previewOrderEvent('shopify', shopifyOrder({ source_name: 'some_new_channel' }));
  assert.equal(event.source, 'unknown');
  assert.equal(event.amountCents, 14999);
});

// ── coaching ────────────────────────────────────────────────────────────────

test('a coaching close is recorded against Beauty and is idempotent', async () => {
  const store = fakeStore();
  const args = { subscription: { subscriptionId: 'sub_9', amountCents: 240000 }, store };

  const first = await emitCoachingClose(args);
  const retry = await emitCoachingClose(args);

  assert.equal(first.type, 'coaching_close');
  assert.equal(store.written[0].brand, 'beauty');
  assert.equal(store.written[0].amountCents, 240000);
  assert.equal(retry.duplicate, true);
});

test('a subscription with no amount is skipped', async () => {
  const store = fakeStore();
  const result = await emitCoachingClose({ subscription: { subscriptionId: 'sub_9' }, store });
  assert.equal(result.emitted, false);
  assert.equal(store.written.length, 0);
});

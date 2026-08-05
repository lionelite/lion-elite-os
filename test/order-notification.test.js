'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrder, renderOrderNotificationHtml, buildOrderNotification, brandOf } = require('../lib/orders/order-notification');

// Synthetic payloads only — never real customer data.
const shopifyPayload = {
  id: 1234567,
  email: 'jane@example.com',
  gateway: 'stripe',
  customer: { first_name: 'Jane', last_name: 'Example', phone: '555-0100' },
  shipping_address: { first_name: 'Jane', last_name: 'Example', address1: '1 Example St', city: 'Cleveland', province_code: 'OH', zip: '44101' },
  shipping_lines: [{ title: 'UPS Ground' }],
  line_items: [
    { title: 'Radiance Serum', quantity: 1, price: '48.00' },
    { title: 'Renewal Kit', quantity: 2, price: '90.00' }
  ],
  total_price: '228.00'
};

test('normalizeOrder maps a Shopify payload and prefixes the order id per brand', () => {
  const w = normalizeOrder('shopify', shopifyPayload, { brandKey: 'wellness' });
  const b = normalizeOrder('shopify', shopifyPayload, { brandKey: 'beauty' });
  assert.match(w.orderId, /^LEW-/);
  assert.match(b.orderId, /^LEB-/);
  assert.equal(b.customer.name, 'Jane Example');
  assert.equal(b.items.length, 2);
  assert.equal(b.items[0].price, '$48.00');
  assert.equal(b.total, '$228.00');
  assert.equal(b.shipTo.method, 'UPS Ground');
});

test('normalizeOrder maps a Stripe checkout session', () => {
  const stripe = normalizeOrder('stripe', {
    id: 'cs_test_abc123',
    amount_total: 4800,
    customer_details: { name: 'Jane Example', email: 'jane@example.com', address: { line1: '1 Example St', city: 'Cleveland', state: 'OH', postal_code: '44101' } },
    __items: [{ name: 'Radiance Serum', qty: 1, price: 48 }]
  }, { brandKey: 'beauty' });
  assert.equal(stripe.paymentVia, 'Stripe');
  assert.equal(stripe.total, '$48.00');
  assert.match(stripe.orderId, /^LEB-/);
});

test('rendered HTML matches the notification design (header, order, action, items)', () => {
  const order = normalizeOrder('shopify', shopifyPayload, { brandKey: 'beauty' });
  const html = renderOrderNotificationHtml(order, { brandKey: 'beauty', receiptActionUrl: 'https://x/receipt/1' });
  assert.match(html, /NEW ORDER — ACTION REQUIRED/);
  assert.match(html, /LION ELITE BEAUTY — INTERNAL NOTIFICATION/);
  assert.match(html, /Order LEB-/);
  assert.match(html, /Send Receipt to Customer/);
  assert.match(html, /Radiance Serum/);
  assert.match(html, /https:\/\/x\/receipt\/1/);
});

test('buildOrderNotification keeps the "🛒 New Order" subject convention', () => {
  const n = buildOrderNotification('shopify', shopifyPayload, { brandKey: 'beauty' });
  assert.match(n.subject, /New Order/);
  assert.match(n.subject, /Lion Elite Beauty/);
  assert.match(n.text, /NEW ORDER/);
});

test('both brands are defined with distinct prefixes', () => {
  assert.equal(brandOf('wellness').prefix, 'LEW');
  assert.equal(brandOf('beauty').prefix, 'LEB');
});

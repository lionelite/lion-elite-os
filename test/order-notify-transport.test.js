'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isOrderEvent, brandFromEvent } = require('../lib/orders/order-notification');
const { notifyReadiness, sendOrderNotification } = require('../lib/orders/notify-transport');

test('isOrderEvent recognizes Shopify + Stripe order events, ignores others', () => {
  assert.equal(isOrderEvent('shopify', 'orders/create'), true);
  assert.equal(isOrderEvent('shopify', 'orders/paid'), true);
  assert.equal(isOrderEvent('stripe', 'checkout.session.completed'), true);
  assert.equal(isOrderEvent('stripe', 'payment_intent.succeeded'), true);
  assert.equal(isOrderEvent('stripe', 'customer.subscription.updated'), false);
  assert.equal(isOrderEvent('gmail', 'message'), false);
});

test('brandFromEvent infers beauty from shop domain / explicit metadata, defaults wellness', () => {
  assert.equal(brandFromEvent({ metadata: { shopDomain: 'lionelitebeauty.myshopify.com' } }), 'beauty');
  assert.equal(brandFromEvent({ metadata: { brand: 'beauty' } }), 'beauty');
  assert.equal(brandFromEvent({ metadata: { shopDomain: 'lionelitewellness.myshopify.com' } }), 'wellness');
  assert.equal(brandFromEvent({}), 'wellness');
});

test('notifyReadiness reports missing config; skips fail-closed', () => {
  const { ready, missing } = notifyReadiness({});
  assert.equal(ready, false);
  assert.ok(missing.includes('ORDER_NOTIFY_ENABLED'));
});

test('sendOrderNotification returns skipped (never throws) when unconfigured', async () => {
  const r = await sendOrderNotification({ subject: 's', html: '<b>h</b>' }, { env: {} });
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'not_configured');
});

test('sendOrderNotification posts to Resend when fully configured', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return { ok: true, json: async () => ({ id: 'email_123' }) };
  };
  const env = {
    ORDER_NOTIFY_ENABLED: 'true',
    OWNER_ORDER_NOTIFICATION_EMAIL: 'ops@lionelitebeauty.com',
    ORDER_NOTIFY_FROM: 'orders@lionelitebeauty.com',
    RESEND_API_KEY: 'rk_test'
  };
  const r = await sendOrderNotification({ subject: '🛒 New Order', html: '<b>x</b>', text: 'x' }, { fetchImpl: fakeFetch, env });
  assert.equal(r.status, 'sent');
  assert.equal(r.providerId, 'email_123');
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.body.to[0], 'ops@lionelitebeauty.com');
  assert.equal(captured.auth, 'Bearer rk_test');
});

test('sendOrderNotification returns error (non-fatal) on provider failure', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) });
  const env = { ORDER_NOTIFY_ENABLED: 'true', OWNER_ORDER_NOTIFICATION_EMAIL: 'o@x.com', ORDER_NOTIFY_FROM: 'f@x.com', RESEND_API_KEY: 'k' };
  const r = await sendOrderNotification({ subject: 's', html: 'h' }, { fetchImpl: fakeFetch, env });
  assert.equal(r.status, 'error');
  assert.equal(r.providerStatus, 500);
});

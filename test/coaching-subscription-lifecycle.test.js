'use strict';

// When someone stops paying, they must stop having the product.
//
// Before this, the checkout webhook only handled checkout.session.completed.
// A customer who cancelled kept full coaching access forever — plans,
// messages, the coach's time — because nothing ever changed their status and
// nothing else looked at their subscription.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const { extractLifecycle, applyLifecycle } = require('../lib/coaching/stripe-webhook');
const { MemoryCoachingStore } = require('../lib/coaching/store');
const { createCheckoutRouter } = require('../routes/checkout');

const SECRET = 'whsec_lifecycle_test';

function event(type, object) {
  return { id: `evt_${type}`, type, data: { object } };
}

// --------------------------------------------------------------------------
// Which events change access
// --------------------------------------------------------------------------

test('a cancelled subscription revokes access', () => {
  const instruction = extractLifecycle(event('customer.subscription.deleted', { id: 'sub_1' }));
  assert.equal(instruction.intent, 'revoke');
  assert.equal(instruction.status, 'archived', 'archived is the status the session layer refuses');
  assert.equal(instruction.subscriptionId, 'sub_1');
});

test('a failed payment flags risk but does NOT cut access', () => {
  const instruction = extractLifecycle(event('invoice.payment_failed', { subscription: 'sub_1' }));
  assert.equal(instruction.intent, 'at_risk');
  assert.equal(
    instruction.status,
    'paused',
    'Stripe retries a card for days; locking out an expired card on the first failure punishes a customer who would have paid'
  );
});

test('a successful payment restores access', () => {
  assert.equal(extractLifecycle(event('invoice.paid', { subscription: 'sub_1' })).intent, 'restore');
  assert.equal(extractLifecycle(event('invoice.payment_succeeded', { subscription: 'sub_1' })).intent, 'restore');
});

test('unrelated events change nothing', () => {
  assert.equal(extractLifecycle(event('checkout.session.completed', { subscription: 'sub_1' })), null);
  assert.equal(extractLifecycle(event('customer.created', { id: 'cus_1' })), null);
  assert.equal(extractLifecycle(event('invoice.paid', {})), null, 'no subscription means nothing to act on');
  assert.equal(extractLifecycle(null), null);
});

// --------------------------------------------------------------------------
// Applying it to a real store
// --------------------------------------------------------------------------

async function storeWithClient(subscriptionId = 'sub_1') {
  const store = new MemoryCoachingStore();
  const client = await store.createClient({
    email: 'payer@example.test',
    firstName: 'Pat',
    lastName: 'Payer',
    subscriptionId
  });
  return { store, client };
}

test('cancelling archives the client, so their session stops working', async () => {
  const { store, client } = await storeWithClient();

  const outcome = await applyLifecycle({ event: event('customer.subscription.deleted', { id: 'sub_1' }), store });

  assert.equal(outcome.status, 'applied');
  assert.equal((await store.getClient(client.clientId)).status, 'archived');
});

test('an existing session stops working the moment access is revoked', async () => {
  // The status field is only a means to an end. What matters is that a client
  // who already has a valid session cookie cannot keep using the app after
  // they cancel — otherwise revoking access changes nothing until they log out.
  const { store, client } = await storeWithClient();
  await store.createSession('session-hash', 'client', client.clientId, new Date(Date.now() + 86400000));

  assert.ok(await store.getSession('session-hash'), 'the session should work while they are paying');

  await applyLifecycle({ event: event('customer.subscription.deleted', { id: 'sub_1' }), store });

  assert.equal(await store.getSession('session-hash'), null, 'a cancelled client must be locked out');
});

test('a failed payment leaves the client able to log in', async () => {
  const { store, client } = await storeWithClient();

  await applyLifecycle({ event: event('invoice.payment_failed', { subscription: 'sub_1' }), store });

  const updated = await store.getClient(client.clientId);
  assert.equal(updated.status, 'paused');
  assert.notEqual(updated.status, 'archived', 'a retryable card failure must not lock them out');
});

test('paying again brings a cancelled client back', async () => {
  const { store, client } = await storeWithClient();

  await applyLifecycle({ event: event('customer.subscription.deleted', { id: 'sub_1' }), store });
  assert.equal((await store.getClient(client.clientId)).status, 'archived');

  await applyLifecycle({ event: event('invoice.paid', { subscription: 'sub_1' }), store });
  assert.equal((await store.getClient(client.clientId)).status, 'active');
});

test('billing events never overwrite a client\'s details', async () => {
  const { store, client } = await storeWithClient();

  await applyLifecycle({ event: event('customer.subscription.deleted', { id: 'sub_1' }), store });

  const updated = await store.getClient(client.clientId);
  assert.equal(updated.email, 'payer@example.test', 'a billing event knows nothing about names or emails');
  assert.equal(updated.firstName, 'Pat');
  assert.equal(updated.lastName, 'Payer');
});

test('a subscription with no matching client is not an error', async () => {
  const { store } = await storeWithClient('sub_1');
  const outcome = await applyLifecycle({ event: event('invoice.paid', { subscription: 'sub_other' }), store });
  assert.equal(outcome.status, 'unmatched', 'other products bill through the same account');
});

test('a redelivered event is a no-op', async () => {
  const { store, client } = await storeWithClient();
  const cancelled = event('customer.subscription.deleted', { id: 'sub_1' });

  assert.equal((await applyLifecycle({ event: cancelled, store })).status, 'applied');
  assert.equal((await applyLifecycle({ event: cancelled, store })).status, 'unchanged');
  assert.equal((await store.getClient(client.clientId)).status, 'archived');
});

test('a store failure is reported so Stripe retries', async () => {
  const broken = {
    findClientBySubscriptionId: async () => { throw new Error('database is down'); }
  };
  const outcome = await applyLifecycle({ event: event('invoice.paid', { subscription: 'sub_1' }), store: broken });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /database is down/);
});

// --------------------------------------------------------------------------
// End to end over HTTP
// --------------------------------------------------------------------------

function sign(rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function startServer(store) {
  const app = express();
  app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
  app.use('/api/checkout', createCheckoutRouter({ store, env: { STRIPE_WEBHOOK_SECRET: SECRET } }));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('a signed cancellation over HTTP ends access', async () => {
  const { store, client } = await storeWithClient();
  const { server, base } = await startServer(store);

  try {
    const raw = JSON.stringify(event('customer.subscription.deleted', { id: 'sub_1' }));
    const response = await fetch(`${base}/api/checkout/stripe-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sign(raw) },
      body: raw
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).lifecycle, 'applied');
    assert.equal((await store.getClient(client.clientId)).status, 'archived');
  } finally {
    server.close();
  }
});

test('an unsigned cancellation cannot revoke anyone', async () => {
  const { store, client } = await storeWithClient();
  const { server, base } = await startServer(store);

  try {
    const response = await fetch(`${base}/api/checkout/stripe-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event('customer.subscription.deleted', { id: 'sub_1' }))
    });

    assert.equal(response.status, 401);
    assert.equal(
      (await store.getClient(client.clientId)).status,
      'active',
      'forged events must not be able to cut off a paying customer'
    );
  } finally {
    server.close();
  }
});

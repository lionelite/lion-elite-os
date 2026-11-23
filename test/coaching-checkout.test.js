'use strict';

// Payment is the one path where a bug either loses money or gives the product
// away, so the cases pinned here are: nothing works until it is configured,
// what Stripe is actually asked to charge, unsigned webhooks are refused, and
// a retried delivery does not provision twice.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

const {
  resolveCheckoutConfig,
  buildCheckoutParams,
  createCheckoutSession
} = require('../lib/coaching/stripe-checkout');
const {
  verifyStripeSignature,
  extractProvisioning,
  provisionFromEvent,
  splitName
} = require('../lib/coaching/stripe-webhook');
const { createCheckoutRouter, cleanEmail } = require('../routes/checkout');

const CONFIGURED = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_PRICE_ID: 'price_abc123',
  COACHING_PUBLIC_URL: 'https://coaching.example.test'
};

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

test('checkout stays off until both Stripe settings exist', () => {
  assert.deepEqual(resolveCheckoutConfig({}).missing, ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID']);
  assert.equal(resolveCheckoutConfig({}).enabled, false);
  assert.equal(resolveCheckoutConfig({ STRIPE_SECRET_KEY: 'sk_test_1' }).enabled, false);
  assert.deepEqual(resolveCheckoutConfig({ STRIPE_SECRET_KEY: 'sk_test_1' }).missing, ['STRIPE_PRICE_ID']);
  assert.equal(resolveCheckoutConfig(CONFIGURED).enabled, true);
});

test('an unconfigured checkout refuses instead of pretending to work', async () => {
  const result = await createCheckoutSession({
    env: {},
    fetchImpl: () => assert.fail('Stripe must not be called without configuration')
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
  assert.deepEqual(result.missing, ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID']);
});

// --------------------------------------------------------------------------
// What Stripe is asked for
// --------------------------------------------------------------------------

test('the price is referenced by id, never invented in code', () => {
  const params = buildCheckoutParams({ priceId: 'price_abc123', baseUrl: 'https://x.test' });
  assert.equal(params.get('line_items[0][price]'), 'price_abc123');
  assert.equal(params.get('line_items[0][quantity]'), '1');
  assert.equal(params.get('mode'), 'subscription');
  // No amount or currency anywhere: what the customer pays is owned by Stripe.
  const body = params.toString();
  assert.ok(!body.includes('unit_amount'), 'code must never set an amount');
  assert.ok(!body.includes('currency='), 'code must never set a currency');
});

test('return URLs point back at the app and the join page', () => {
  const params = buildCheckoutParams({ priceId: 'price_1', baseUrl: 'https://coaching.example.test/' });
  assert.equal(params.get('success_url'), 'https://coaching.example.test/coaching/?checkout=success');
  assert.equal(params.get('cancel_url'), 'https://coaching.example.test/join/?checkout=cancelled');
});

test('an email prefills checkout only when supplied', () => {
  assert.equal(
    buildCheckoutParams({ priceId: 'p', baseUrl: 'https://x.test', email: 'a@b.test' }).get('customer_email'),
    'a@b.test'
  );
  assert.equal(buildCheckoutParams({ priceId: 'p', baseUrl: 'https://x.test' }).has('customer_email'), false);
});

test('returns the Stripe URL on success', async () => {
  let seen = null;
  const result = await createCheckoutSession({
    env: CONFIGURED,
    email: 'buyer@example.test',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(seen.options.headers.Authorization, 'Bearer sk_test_123');
  assert.match(seen.options.headers['Content-Type'], /x-www-form-urlencoded/);
});

test("surfaces Stripe's own error message, which is usually the fix", async () => {
  const result = await createCheckoutSession({
    env: CONFIGURED,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'No such price: price_abc123' } })
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stripe_error');
  assert.match(result.detail, /No such price/);
});

test('a network failure is reported, not thrown', async () => {
  const result = await createCheckoutSession({
    env: CONFIGURED,
    fetchImpl: async () => { throw new Error('socket hang up'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network_error');
});

// --------------------------------------------------------------------------
// Webhook signature
// --------------------------------------------------------------------------

const SECRET = 'whsec_test_secret';

function sign(rawBody, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

test('accepts a correctly signed payload', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  assert.equal(verifyStripeSignature({ rawBody: body, signatureHeader: sign(body), secret: SECRET }), true);
});

test('refuses forged, tampered, replayed, and unsigned payloads', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  const header = sign(body);

  assert.equal(
    verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: 'whsec_wrong' }),
    false,
    'a different secret must not validate'
  );
  assert.equal(
    verifyStripeSignature({ rawBody: `${body} `, signatureHeader: header, secret: SECRET }),
    false,
    'the body cannot be altered after signing'
  );
  assert.equal(
    verifyStripeSignature({
      rawBody: body,
      signatureHeader: sign(body, SECRET, Math.floor(Date.now() / 1000) - 4000),
      secret: SECRET
    }),
    false,
    'an old signature is a replay'
  );
  assert.equal(verifyStripeSignature({ rawBody: body, signatureHeader: '', secret: SECRET }), false);
  assert.equal(verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: '' }), false);
  assert.equal(
    verifyStripeSignature({ rawBody: body, signatureHeader: 't=123', secret: SECRET }),
    false,
    'a timestamp with no signature proves nothing'
  );
});

// --------------------------------------------------------------------------
// Turning a payment into access
// --------------------------------------------------------------------------

function paidEvent(overrides = {}) {
  return {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        subscription: 'sub_123',
        customer_details: { email: 'Buyer@Example.test', name: 'Alex The Lion' },
        ...overrides
      }
    }
  };
}

test('reads the buyer out of a completed checkout', () => {
  const details = extractProvisioning(paidEvent());
  assert.equal(details.email, 'buyer@example.test', 'email is normalized');
  assert.equal(details.firstName, 'Alex');
  assert.equal(details.lastName, 'The Lion');
  assert.equal(details.subscriptionId, 'sub_123');
});

test('ignores events that are not a completed checkout', () => {
  assert.equal(extractProvisioning({ type: 'invoice.paid', data: { object: {} } }), null);
  assert.equal(extractProvisioning({ type: 'checkout.session.completed', data: { object: {} } }), null);
  assert.equal(extractProvisioning(null), null);
});

test('a missing name never blocks a paying customer', () => {
  const details = extractProvisioning(paidEvent({ customer_details: { email: 'solo@example.test' } }));
  assert.equal(details.firstName, 'solo');
  assert.equal(details.lastName, '');
  assert.deepEqual(splitName('  Mary  Jane   Watson '), { firstName: 'Mary', lastName: 'Jane Watson' });
});

test('paying creates the coaching client, which is what sends the invite', async () => {
  const created = [];
  const store = { createClient: async (input) => { created.push(input); return { clientId: 'c1' }; } };

  const outcome = await provisionFromEvent({ event: paidEvent(), store });

  assert.equal(outcome.status, 'provisioned');
  assert.equal(created.length, 1);
  assert.equal(created[0].email, 'buyer@example.test');
  assert.equal(created[0].subscriptionId, 'sub_123');
  assert.equal(created[0].profile.source, 'stripe_checkout');
});

test('a redelivered event does not provision twice', async () => {
  const conflict = Object.assign(new Error('A coaching client with that email already exists.'), { statusCode: 409 });
  const outcome = await provisionFromEvent({
    event: paidEvent(),
    store: { createClient: async () => { throw conflict; } }
  });
  assert.equal(outcome.status, 'already_provisioned', 'Stripe retries; that must be harmless');

  const duplicateKey = Object.assign(new Error('duplicate key'), { code: '23505' });
  const second = await provisionFromEvent({
    event: paidEvent(),
    store: { createClient: async () => { throw duplicateKey; } }
  });
  assert.equal(second.status, 'already_provisioned');
});

test('a real provisioning failure is reported so it can be retried', async () => {
  const outcome = await provisionFromEvent({
    event: paidEvent(),
    store: { createClient: async () => { throw new Error('database is down'); } }
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /database is down/);
});

// --------------------------------------------------------------------------
// The live HTTP surface
// --------------------------------------------------------------------------

function startServer(env, store) {
  const app = express();
  app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
  app.use('/api/checkout', createCheckoutRouter({ store, env }));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('health reports what is missing without leaking a secret', async () => {
  const { server, base } = await startServer({}, { createClient: async () => ({}) });
  try {
    const response = await fetch(`${base}/api/checkout/health`);
    const body = await response.json();
    assert.equal(body.checkoutConfigured, false);
    assert.deepEqual(body.missing, ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID']);
    assert.ok(!JSON.stringify(body).includes('sk_'), 'no key material in the response');
  } finally {
    server.close();
  }
});

test('an unsigned webhook cannot mint free coaching access', async () => {
  const created = [];
  const store = { createClient: async (input) => { created.push(input); return { clientId: 'c1' }; } };
  const { server, base } = await startServer({ STRIPE_WEBHOOK_SECRET: SECRET }, store);

  try {
    const response = await fetch(`${base}/api/checkout/stripe-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paidEvent())
    });
    assert.equal(response.status, 401);
    assert.equal(created.length, 0, 'a forged payment must never create a client');
  } finally {
    server.close();
  }
});

test('a properly signed webhook provisions access', async () => {
  const created = [];
  const store = { createClient: async (input) => { created.push(input); return { clientId: 'c1' }; } };
  const { server, base } = await startServer({ STRIPE_WEBHOOK_SECRET: SECRET }, store);

  try {
    const raw = JSON.stringify(paidEvent());
    const response = await fetch(`${base}/api/checkout/stripe-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sign(raw) },
      body: raw
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'provisioned');
    assert.equal(created.length, 1);
    assert.equal(created[0].email, 'buyer@example.test');
  } finally {
    server.close();
  }
});

test('the webhook refuses to run at all until its secret is set', async () => {
  const { server, base } = await startServer({}, { createClient: async () => ({}) });
  try {
    const response = await fetch(`${base}/api/checkout/stripe-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paidEvent())
    });
    assert.equal(response.status, 503, 'no secret means no verification is possible');
  } finally {
    server.close();
  }
});

test('starting a session before configuration returns 503, not a broken page', async () => {
  const { server, base } = await startServer({}, { createClient: async () => ({}) });
  try {
    const response = await fetch(`${base}/api/checkout/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'buyer@example.test' })
    });
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).missing, ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID']);
  } finally {
    server.close();
  }
});

test('only a plausible email is passed through as a prefill', () => {
  assert.equal(cleanEmail('  Buyer@Example.test '), 'buyer@example.test');
  assert.equal(cleanEmail('not-an-email'), '');
  assert.equal(cleanEmail(''), '');
  assert.equal(cleanEmail(`${'a'.repeat(250)}@b.test`), '');
});

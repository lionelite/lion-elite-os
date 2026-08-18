'use strict';

// Public payment surface for Lion Elite coaching.
//
// Kept as its own router, mounted at /api/checkout, rather than folded into
// routes/coaching.js: that file is under active development by the coaching
// workstream, and its router-wide middleware enforces same-origin on every
// POST — correct for an app session, wrong for a Stripe webhook, which
// legitimately arrives from Stripe's servers with no Origin header and is
// authenticated by signature instead.
//
// Three endpoints:
//   GET  /api/checkout/health        - is payment configured? (no secrets)
//   POST /api/checkout/session       - start a purchase, returns a Stripe URL
//   POST /api/checkout/stripe-webhook - Stripe tells us a payment completed

const express = require('express');

const { createCheckoutSession, resolveCheckoutConfig } = require('../lib/coaching/stripe-checkout');
const { verifyStripeSignature, provisionFromEvent } = require('../lib/coaching/stripe-webhook');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/** Small in-memory limiter; checkout is low volume and this is one process. */
function createRateLimiter({ windowMs, limit }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }
    return next();
  };
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  // Prefill only — Stripe validates properly on its own page.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : '';
}

/**
 * @param {object} input
 * @param {object} input.store - coaching store, used to provision on payment
 * @param {object} [input.env]
 */
function createCheckoutRouter({ store, env = process.env } = {}) {
  if (!store) throw new Error('Coaching store is required.');
  const router = express.Router();
  const checkoutLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 20 });

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Readiness without leaking anything secret: says WHAT is missing, never a value.
  router.get('/health', (_req, res) => {
    const config = resolveCheckoutConfig(env);
    res.json({
      status: 'ok',
      service: 'lion-elite-checkout',
      checkoutConfigured: config.enabled,
      webhookConfigured: Boolean(String(env.STRIPE_WEBHOOK_SECRET || '').trim()),
      missing: config.missing
    });
  });

  router.post('/session', checkoutLimiter, asyncRoute(async (req, res) => {
    const result = await createCheckoutSession({ email: cleanEmail(req.body?.email), env });

    if (result.ok) {
      return res.json({ url: result.url });
    }
    if (result.reason === 'not_configured') {
      // Explicitly a 503, not a 500: nothing is broken, payment simply has not
      // been switched on yet by the owner.
      return res.status(503).json({
        error: 'Checkout is not configured yet.',
        missing: result.missing
      });
    }
    return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }));

  // Stripe posts here. Authenticated by signature over the RAW body, which
  // server.js captures as req.rawBody.
  router.post('/stripe-webhook', asyncRoute(async (req, res) => {
    const secret = String(env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!secret) {
      return res.status(503).json({ error: 'WEBHOOK_NOT_CONFIGURED' });
    }

    const verified = verifyStripeSignature({
      rawBody: req.rawBody,
      signatureHeader: req.get('stripe-signature'),
      secret
    });
    if (!verified) {
      return res.status(401).json({ error: 'INVALID_STRIPE_SIGNATURE' });
    }

    // req.body is already parsed by express.json; rawBody was only needed for
    // the signature.
    const outcome = await provisionFromEvent({ event: req.body, store });

    if (outcome.status === 'failed') {
      // Return 500 so Stripe retries — a paying customer without access is
      // the one failure mode worth being noisy about.
      console.error(`[checkout] provisioning failed for ${outcome.email || 'unknown'}: ${outcome.detail}`);
      return res.status(500).json({ error: 'PROVISIONING_FAILED' });
    }

    if (outcome.status === 'provisioned') {
      console.log(`[checkout] coaching access provisioned for ${outcome.email}`);
    }
    return res.json({ received: true, status: outcome.status });
  }));

  return router;
}

module.exports = { createCheckoutRouter, cleanEmail };

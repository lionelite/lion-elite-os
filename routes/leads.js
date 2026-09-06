'use strict';

// Public B2C lead capture.
//
// This is the only lawful way a consumer or coach enters the marketing
// pipeline: they submit it themselves, having been shown what they are agreeing
// to. There is deliberately no import, no upload and no bulk path — a route
// that accepted a list would be a route that manufactured consent.

const express = require('express');
const { buildCapture, LANES } = require('../lib/leads/consent-capture');

function createRateLimiter({ windowMs, limit }) {
  const buckets = new Map();
  return (req, _res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > limit) {
      const error = new Error('Too many submissions. Try again shortly.');
      error.statusCode = 429;
      return next(error);
    }
    if (buckets.size > 5000) {
      for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
    }
    next();
  };
}

function createLeadsRouter({ store } = {}) {
  if (!store) throw new Error('Lead store is required.');
  const router = express.Router();
  const limiter = createRateLimiter({ windowMs: 10 * 60 * 1000, limit: 20 });

  const asyncRoute = handler => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

  router.get('/lanes', (_req, res) => {
    res.json({ lanes: Object.values(LANES) });
  });

  router.post('/capture', limiter, asyncRoute(async (req, res) => {
    const capture = buildCapture(req.body, {
      // Observed here, never read from the body.
      ip: req.ip || req.socket?.remoteAddress || '',
      userAgent: req.get('user-agent') || ''
    });
    const lead = await store.saveCapture(capture);
    res.status(201).json({
      lead: { leadId: lead.leadId, lane: lead.lane, email: lead.email, status: lead.status },
      // Echoed so the caller can show the right confirmation, and so a form
      // that thinks it collected SMS consent can tell when it did not.
      consent: {
        email: lead.emailMarketingConsent,
        sms: lead.smsMarketingConsent
      }
    });
  }));

  router.post('/unsubscribe', limiter, asyncRoute(async (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (!email) {
      const error = new Error('An email address is required.');
      error.statusCode = 400;
      throw error;
    }
    const updated = await store.unsubscribe(email, req.body?.lane);
    // Always the same answer: whether an address is on a list is not something
    // an unauthenticated caller gets to probe.
    res.json({ unsubscribed: true, records: updated.length });
  }));

  router.use((error, _req, res, _next) => {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('[leads] request failed:', error.message);
    res.status(status).json({
      error: status >= 500 ? 'Lead capture is temporarily unavailable.' : error.message
    });
  });

  return router;
}

module.exports = { createLeadsRouter };

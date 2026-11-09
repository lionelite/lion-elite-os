'use strict';

/**
 * BuildPipeline VSL funnel API, mounted at /api/gtm-funnels.
 *
 * Public (what apps/buildpipeline calls — server-to-server through its own route
 * handlers, so no CORS is opened here):
 *   GET  /public/:slug                    published funnel config
 *   POST /public/:slug/events             browser analytics event (no PII)
 *   POST /public/:slug/leads              application → CRM prospect
 *   POST /public/:slug/calendly-webhook   signed Calendly invitee.created → booking confirmed
 *
 * Workspace (session + membership, like routes/gtm-platform.js):
 *   GET  /workspaces/:workspaceId/funnels
 *   PUT  /workspaces/:workspaceId/funnels/:slug
 *   GET  /workspaces/:workspaceId/funnels/:slug/report
 *   POST /workspaces/:workspaceId/funnels/:slug/bookings/confirm
 *
 * Nothing here sends a message. Follow-up is queued as draft_only agent tasks.
 */

const crypto = require('crypto');
const express = require('express');
const { createAuthMiddleware } = require('../lib/platform/security/auth-middleware');
const { FunnelError, buildClientEvent, validateLead, publicFunnelView } = require('../lib/platform/vsl-funnel');

/**
 * The visitor's address for rate limiting. apps/buildpipeline calls these
 * routes server-side, so `req.ip` is the funnel app's own address and every
 * visitor would share one bucket. The app forwards the visitor's address in
 * `x-buildpipeline-client-ip`, which is believed only alongside the shared
 * BUILDPIPELINE_PROXY_SECRET — otherwise anyone could pick their own bucket.
 */
function clientKey(req, env = process.env) {
  const secret = String(env.BUILDPIPELINE_PROXY_SECRET || '');
  const provided = String(req.headers['x-buildpipeline-proxy-secret'] || '');
  if (secret && provided.length === secret.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) {
    const forwarded = String(req.headers['x-buildpipeline-client-ip'] || '').split(',')[0].trim();
    if (forwarded) return `fwd:${forwarded.slice(0, 64)}`;
  }
  return req.ip || 'unknown';
}

/** Small fixed-window limiter per (client, bucket). Public endpoints only. */
function createRateLimiter({ windowMs = 60_000, max = 60, now = () => Date.now(), env = process.env } = {}) {
  const hits = new Map();
  return function limit(bucket) {
    return (req, res, next) => {
      const key = `${bucket}:${clientKey(req, env)}`;
      const t = now();
      const entry = hits.get(key);
      if (!entry || t - entry.start >= windowMs) {
        hits.set(key, { start: t, count: 1 });
        if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
        return next();
      }
      entry.count += 1;
      if (entry.count > max) return res.status(429).json({ error: 'too many requests' });
      next();
    };
  };
}

/**
 * Calendly signs webhooks as `Calendly-Webhook-Signature: t=<unix>,v1=<hex>`
 * where v1 = HMAC-SHA256(signingKey, `${t}.${rawBody}`).
 */
function verifyCalendlySignature({ header, rawBody, signingKey, toleranceSeconds = 180, now = Math.floor(Date.now() / 1000) }) {
  if (!signingKey || !header || !rawBody) return false;
  const parts = Object.fromEntries(String(header).split(',').map(p => p.trim().split('=')));
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceSeconds || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', signingKey).update(`${ts}.${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(parts.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendError(res, error) {
  if (error instanceof FunnelError) {
    // The honeypot rejection is deliberately uninformative.
    if (error.code === 'HONEYPOT') return res.status(400).json({ error: 'rejected' });
    return res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
  console.error('[gtm-funnels]', error && error.message);
  return res.status(500).json({ error: 'funnel service unavailable' });
}

function createGtmFunnelsRouter({ store, authStore, rateLimiter = createRateLimiter(), env = process.env } = {}) {
  if (!store) throw new Error('createGtmFunnelsRouter requires a funnel store');
  const router = express.Router();
  const auth = authStore ? createAuthMiddleware(authStore) : null;

  // Without an auth store (no DATABASE_URL) the workspace routes are open for
  // local development against the memory store — but never in production, where
  // an open PUT would let anyone rewrite a live funnel.
  const role = name => {
    if (auth) return auth.requireWorkspaceRole(name);
    return (_req, res, next) =>
      env.NODE_ENV === 'production' ? res.status(503).json({ error: 'workspace authentication unavailable' }) : next();
  };

  async function loadPublished(req, res) {
    const funnel = await store.getPublishedFunnel(req.params.slug);
    if (!funnel) {
      res.status(404).json({ error: 'funnel not found' });
      return null;
    }
    return funnel;
  }

  router.get('/public/:slug', rateLimiter('config'), async (req, res) => {
    try {
      const funnel = await loadPublished(req, res);
      if (!funnel) return;
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ funnel: publicFunnelView(funnel) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/public/:slug/events', rateLimiter('events'), async (req, res) => {
    try {
      const funnel = await loadPublished(req, res);
      if (!funnel) return;
      const ev = buildClientEvent(req.body);
      const result = await store.recordClientEvent(funnel, ev);
      res.status(result.recorded ? 201 : 200).json({ persisted: true, ...result });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/public/:slug/leads', rateLimiter('leads'), async (req, res) => {
    try {
      const funnel = await loadPublished(req, res);
      if (!funnel) return;
      const lead = validateLead(req.body, funnel.config.qualificationQuestions);
      const result = await store.captureLead(funnel, lead);
      // The prospect id is internal; the page only needs to know it worked.
      res.status(result.duplicate ? 200 : 201).json({ persisted: true, duplicate: result.duplicate });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/public/:slug/calendly-webhook', async (req, res) => {
    try {
      const signingKey = String(env.GTM_CALENDLY_WEBHOOK_SIGNING_KEY || '');
      if (!signingKey) return res.status(503).json({ error: 'calendly webhook not configured' });
      if (!verifyCalendlySignature({ header: req.headers['calendly-webhook-signature'], rawBody: req.rawBody, signingKey })) {
        return res.status(401).json({ error: 'invalid signature' });
      }
      const body = req.body || {};
      if (body.event !== 'invitee.created') return res.json({ ignored: body.event || 'unknown' });
      const funnel = await store.getPublishedFunnel(req.params.slug);
      if (!funnel) return res.status(404).json({ error: 'funnel not found' });
      const payload = body.payload || {};
      // The funnel appends utm_content=<sessionId> to the calendar link, and
      // Calendly echoes UTM parameters back on the invitee.
      const sessionId = String((payload.tracking && payload.tracking.utm_content) || '').trim();
      if (!sessionId) return res.status(202).json({ matched: false, reason: 'no funnel session on the booking' });
      const result = await store.confirmBooking(funnel, {
        sessionId,
        startsAt: payload.scheduled_event && payload.scheduled_event.start_time,
        externalCalendarId: payload.uri || (payload.scheduled_event && payload.scheduled_event.uri) || null,
        actorType: 'integration',
        actorId: 'calendly',
      });
      res.json({ matched: true, duplicate: result.duplicate, tasksQueued: result.tasksQueued });
    } catch (error) {
      if (error instanceof FunnelError && error.code === 'LEAD_NOT_FOUND') return res.status(202).json({ matched: false, reason: 'no application for that session' });
      sendError(res, error);
    }
  });

  router.get('/workspaces/:workspaceId/funnels', role('viewer'), async (req, res) => {
    try {
      res.json({ funnels: await store.listFunnels(req.params.workspaceId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put('/workspaces/:workspaceId/funnels/:slug', role('operator'), async (req, res) => {
    try {
      const funnel = await store.saveFunnel(req.params.workspaceId, { ...(req.body || {}), slug: req.params.slug });
      res.json({ funnel });
    } catch (error) {
      sendError(res, error);
    }
  });

  async function loadOwned(req, res) {
    const funnel = await store.getFunnel(req.params.workspaceId, req.params.slug);
    if (!funnel) {
      res.status(404).json({ error: 'funnel not found' });
      return null;
    }
    return funnel;
  }

  router.get('/workspaces/:workspaceId/funnels/:slug/report', role('viewer'), async (req, res) => {
    try {
      const funnel = await loadOwned(req, res);
      if (!funnel) return;
      res.json({ slug: funnel.slug, status: funnel.status, report: await store.report(funnel) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/workspaces/:workspaceId/funnels/:slug/bookings/confirm', role('operator'), async (req, res) => {
    try {
      const funnel = await loadOwned(req, res);
      if (!funnel) return;
      const { sessionId, prospectId, startsAt, externalCalendarId } = req.body || {};
      if (!sessionId && !prospectId) return res.status(400).json({ error: 'sessionId or prospectId is required' });
      const result = await store.confirmBooking(funnel, {
        sessionId,
        prospectId,
        startsAt,
        externalCalendarId,
        actorType: 'user',
        actorId: req.gtmSession ? req.gtmSession.userId : null,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

module.exports = { createGtmFunnelsRouter, createRateLimiter, verifyCalendlySignature, clientKey };

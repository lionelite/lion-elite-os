'use strict';

const crypto = require('crypto');
const express = require('express');
const { addJob, queueMetrics } = require('./lib/job-queues');
const { ensureConnected, getRedis } = require('./lib/redis');
const gmail = require('./lib/gmail-integration');

const app = express();
const port = Number(process.env.PORT || 10000);
const maxBody = process.env.INTEGRATION_MAX_BODY || '1mb';

app.use(express.json({ limit: maxBody, verify: (req, _res, buffer) => { req.rawBody = buffer; } }));

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireBearer(req, res, next) {
  const expected = process.env.INTEGRATION_GATEWAY_TOKEN;
  if (!expected) return res.status(503).json({ error: 'GATEWAY_TOKEN_NOT_CONFIGURED' });
  const actual = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(actual, expected)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function verifyShopify(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('base64');
  return safeEqual(req.headers['x-shopify-hmac-sha256'], expected);
}

function verifySharedSecret(req, envKey, headerName = 'x-lion-signature') {
  const secret = process.env[envKey];
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('hex');
  return safeEqual(req.headers[headerName], expected);
}

async function enqueue(source, eventType, payload, metadata = {}) {
  const eventId = metadata.eventId || crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  const job = await addJob('integrations', 'normalize-integration-event', {
    eventId, source, eventType, payload, metadata, receivedAt
  }, { jobId: `${source}:${eventId}`, removeOnComplete: 1000, removeOnFail: 2000 });
  return { accepted: true, eventId, jobId: job.id, receivedAt };
}

app.get('/health', async (_req, res) => {
  try {
    const redis = await ensureConnected(getRedis());
    const metrics = await queueMetrics();
    res.json({ status: 'ok', service: 'lion-elite-integration-gateway', redis: Boolean(redis), integrations: metrics.integrations || {} });
  } catch (error) {
    res.status(503).json({ status: 'degraded', error: error.message });
  }
});

app.get('/status', requireBearer, async (_req, res) => {
  const redis = await ensureConnected(getRedis());
  const latest = await redis.hgetall('integrations:latest');
  const counts = await redis.hgetall('integrations:counts');
  res.json({ latest, counts, configured: {
    shopify: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET),
    gmail: Boolean(process.env.GMAIL_WEBHOOK_SECRET),
    calendar: Boolean(process.env.CALENDAR_WEBHOOK_SECRET),
    ads: Boolean(process.env.ADS_WEBHOOK_SECRET)
  }});
});

app.get('/oauth/google/connect', requireBearer, asyncRoute(async (_req, res) => {
  const config = gmail.getConfig();
  const state = gmail.createOAuthState(config.stateSecret);
  res.json({ authorizationUrl: gmail.buildAuthorizationUrl(config, state), redirectUri: config.redirectUri });
}));

app.get('/oauth/google/callback', asyncRoute(async (req, res) => {
  const config = gmail.getConfig();
  if (!gmail.verifyOAuthState(req.query.state, config.stateSecret)) return res.status(400).send('Invalid or expired OAuth state.');
  if (!req.query.code) return res.status(400).send('Google did not return an authorization code.');
  const tokens = await gmail.exchangeCode(req.query.code, config);
  const profile = await gmail.gmailFetch('/profile', tokens.access_token);
  await gmail.saveConnection(tokens, profile, config);
  res.redirect(`${config.publicUrl}/?gmail=connected`);
}));

app.get('/gmail/status', requireBearer, asyncRoute(async (_req, res) => res.json(await gmail.connectionStatus())));

app.post('/gmail/sync', requireBearer, asyncRoute(async (_req, res) => {
  const connection = await gmail.activeConnection();
  if (!connection) return res.status(409).json({ error: 'GMAIL_NOT_CONNECTED' });
  res.json(await gmail.syncConnection(connection, gmail.getConfig()));
}));

app.post('/gmail/disconnect', requireBearer, asyncRoute(async (_req, res) => res.json(await gmail.disconnect())));

app.post('/webhooks/shopify', async (req, res) => {
  if (!verifyShopify(req)) return res.status(401).json({ error: 'INVALID_SHOPIFY_SIGNATURE' });
  const eventType = req.headers['x-shopify-topic'] || 'unknown';
  const eventId = req.headers['x-shopify-webhook-id'];
  res.status(202).json(await enqueue('shopify', eventType, req.body, { eventId, shopDomain: req.headers['x-shopify-shop-domain'] }));
});

for (const config of [
  { source: 'gmail', path: '/webhooks/gmail', secret: 'GMAIL_WEBHOOK_SECRET' },
  { source: 'calendar', path: '/webhooks/calendar', secret: 'CALENDAR_WEBHOOK_SECRET' },
  { source: 'ads', path: '/webhooks/ads', secret: 'ADS_WEBHOOK_SECRET' }
]) {
  app.post(config.path, async (req, res) => {
    if (!verifySharedSecret(req, config.secret)) return res.status(401).json({ error: 'INVALID_SIGNATURE' });
    const eventType = req.headers['x-lion-event-type'] || req.body?.type || 'unknown';
    const eventId = req.headers['x-lion-event-id'];
    res.status(202).json(await enqueue(config.source, eventType, req.body, { eventId }));
  });
}

app.post('/events/:source', requireBearer, async (req, res) => {
  const allowed = new Set(['shopify', 'gmail', 'calendar', 'ads', 'manual']);
  if (!allowed.has(req.params.source)) return res.status(400).json({ error: 'UNSUPPORTED_SOURCE' });
  res.status(202).json(await enqueue(req.params.source, req.body?.type || 'manual-event', req.body?.payload ?? req.body, { submittedBy: 'authorized-api' }));
});

app.use((error, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', event: 'integration_gateway.error', message: error.message }));
  res.status(500).json({ error: 'INTEGRATION_GATEWAY_ERROR' });
});

app.listen(port, () => console.log(JSON.stringify({ level: 'info', event: 'integration_gateway.started', port })));

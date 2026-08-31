'use strict';

const crypto = require('crypto');
const express = require('express');
const { addPublicProspect, listSalesReady } = require('./lib/sdr-pipeline');

const app = express();
const port = Number(process.env.PORT || process.env.SDR_PORT || 3003);

app.use(express.json({ limit: '512kb' }));

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireToken(req, res, next) {
  const expected = process.env.SDR_API_TOKEN;
  if (!expected) return res.status(503).json({ error: 'SDR_API_TOKEN_NOT_CONFIGURED' });
  const actual = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(actual, expected)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'lion-elite-sdr', mode: 'public-business-prospecting' });
});

app.post('/api/sdr/prospects', requireToken, async (req, res, next) => {
  try {
    const result = await addPublicProspect(req.body || {}, req.get('x-actor-id') || 'sdr-agent');
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) { next(error); }
});

app.post('/api/sdr/prospects/batch', requireToken, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.prospects) ? req.body.prospects.slice(0, 100) : [];
    if (!items.length) return res.status(400).json({ error: 'MISSING_PROSPECTS' });
    const results = [];
    for (const item of items) {
      try {
        results.push({ ok: true, result: await addPublicProspect(item, req.get('x-actor-id') || 'sdr-agent') });
      } catch (error) {
        results.push({ ok: false, error: error.code || 'SDR_INGEST_FAILED', message: error.message, business: item?.business?.name || null });
      }
    }
    res.json({ processed: results.length, succeeded: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, results });
  } catch (error) { next(error); }
});

app.get('/api/sdr/sales-ready', requireToken, async (req, res, next) => {
  try {
    const prospects = await listSalesReady({ brand: req.query.brand, limit: req.query.limit || 100 });
    res.json({ count: prospects.length, prospects });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.code ? 422 : 500).json({ error: error.code || 'SDR_SERVER_ERROR', message: error.message });
});

app.listen(port, () => console.log(`Lion Elite SDR service running on port ${port}`));

module.exports = { app, safeEqual, requireToken };

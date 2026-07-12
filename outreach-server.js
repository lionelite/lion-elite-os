'use strict';

const express = require('express');
const {
  createBusinessFingerprint,
  scoreQualification,
  validateProspect,
  authorizeOutreach
} = require('./lib/outreach-validation');
const {
  enrichBusinessEmail,
  enrichBatch
} = require('./lib/email-enrichment');
const { ProspectStore, STAGES } = require('./lib/prospect-store');

const app = express();
const port = process.env.OUTREACH_PORT || 3001;
const store = new ProspectStore();

app.use(express.json({ limit: '1mb' }));

// Quality thresholds reduced by 25% from the original production defaults.
// Hard safety controls remain unchanged: approved sources, suppression, opt-outs,
// duplicate prevention, authorization, channel rules, and frequency limits.
const defaultPolicy = Object.freeze({
  ruleVersion: '1.2.1',
  minimumIdentityConfidence: 0.6,
  minimumQualificationScore: 52.5,
  minimumPersonalizationScore: 56.25,
  minimumEvidenceCoverage: 0.675,
  minimumEmailConfidence: 60,
  maxDataAgeDays: 30,
  maxContactsPerWindow: 3,
  approvedChannels: ['email', 'sms', 'linkedin', 'manual_call'],
  requiredBusinessFields: ['name', 'domain']
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'lion-elite-outreach-validation',
    ruleVersion: defaultPolicy.ruleVersion,
    capabilities: ['validation', 'authorization', 'public_business_email_enrichment', 'prospect_store', 'outreach_queue', 'audit_timeline'],
    timestamp: new Date().toISOString()
  });
});

app.post('/api/outreach/fingerprint', (req, res) => {
  res.json({ fingerprint: createBusinessFingerprint(req.body?.business || req.body || {}) });
});

app.post('/api/outreach/score', (req, res) => {
  const { signals = {}, weights = {} } = req.body || {};
  res.json({ score: scoreQualification(signals, weights) });
});

app.post('/api/outreach/validate', (req, res) => {
  const prospect = req.body?.prospect || {};
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };
  const validation = validateProspect(prospect, policy);
  res.status(validation.passed ? 200 : 422).json({ validation });
});

app.post('/api/outreach/authorize', (req, res) => {
  const prospect = req.body?.prospect || {};
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };
  try {
    const authorization = authorizeOutreach(prospect, policy);
    res.json({ authorization });
  } catch (error) {
    res.status(422).json({ error: error.code || 'OUTREACH_BLOCKED', message: error.message, validation: error.validation });
  }
});

app.post('/api/enrichment/email', async (req, res) => {
  const business = req.body?.business || {};
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };
  const result = await enrichBusinessEmail(business, {
    minimumConfidence: policy.minimumEmailConfidence,
    maxPages: Math.min(Number(req.body?.maxPages || 6), 10)
  });
  res.status(result.status === 'verified' ? 200 : 422).json({ enrichment: result });
});

app.post('/api/enrichment/email/batch', async (req, res) => {
  const businesses = Array.isArray(req.body?.businesses) ? req.body.businesses : [];
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };
  if (!businesses.length) return res.status(400).json({ error: 'MISSING_BUSINESSES' });
  const result = await enrichBatch(businesses, {
    minimumConfidence: policy.minimumEmailConfidence,
    maxPages: Math.min(Number(req.body?.maxPages || 6), 10),
    maxBatchSize: 25
  });
  res.json({ enrichment: result });
});

app.post('/api/prospects', (req, res) => {
  const result = store.create(req.body || {}, req.get('x-actor-id') || 'api');
  res.status(result.duplicate ? 200 : 201).json(result);
});

app.get('/api/prospects', (req, res) => res.json({ prospects: store.list(req.query), stages: STAGES }));

app.get('/api/prospects/:id', (req, res) => {
  const prospect = store.get(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'PROSPECT_NOT_FOUND' });
  res.json({ prospect, timeline: store.timeline(req.params.id) });
});

app.patch('/api/prospects/:id', (req, res) => {
  const prospect = store.update(req.params.id, req.body, req.get('x-actor-id') || 'api');
  if (!prospect) return res.status(404).json({ error: 'PROSPECT_NOT_FOUND' });
  res.json({ prospect });
});

app.post('/api/prospects/:id/transition', (req, res) => {
  try {
    const prospect = store.transition(req.params.id, req.body?.stage, req.body?.metadata, req.get('x-actor-id') || 'api');
    if (!prospect) return res.status(404).json({ error: 'PROSPECT_NOT_FOUND' });
    res.json({ prospect });
  } catch (error) {
    res.status(422).json({ error: error.code || 'TRANSITION_FAILED', message: error.message });
  }
});

app.post('/api/prospects/:id/queue', (req, res) => {
  try {
    const result = store.enqueue(
      req.params.id,
      req.body?.authorization,
      req.body?.message || {},
      req.body?.scheduledAt,
      req.get('x-actor-id') || 'api'
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    res.status(422).json({ error: error.code || 'QUEUE_FAILED', message: error.message });
  }
});

app.get('/api/outreach/queue', (req, res) => res.json({ queue: store.listQueue(req.query) }));

app.patch('/api/outreach/queue/:id', (req, res) => {
  const item = store.markQueue(req.params.id, req.body?.status, req.body?.metadata, req.get('x-actor-id') || 'api');
  if (!item) return res.status(404).json({ error: 'QUEUE_ITEM_NOT_FOUND' });
  res.json({ item });
});

app.get('/api/metrics/pipeline', (req, res) => res.json({ metrics: store.metrics() }));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'The outreach service could not complete the request.' });
});

app.listen(port, () => {
  console.log(`Lion Elite outreach validation service running on port ${port}`);
});

module.exports = { app, defaultPolicy, store };

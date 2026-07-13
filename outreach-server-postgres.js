'use strict';

const express = require('express');
const { healthcheck: databaseHealthcheck } = require('./lib/database');
const { healthcheck: redisHealthcheck } = require('./lib/redis');
const { addJob, queueMetrics } = require('./lib/job-queues');
const { createBusinessFingerprint, scoreQualification, validateProspect, authorizeOutreach } = require('./lib/outreach-validation');
const { enrichBusinessEmail, enrichBatch } = require('./lib/email-enrichment');
const { buildEmail: generateEmailDraft, scoreEmail: scoreEmailDraft } = require('./lib/email-generation');
const { PostgresProspectStore, STAGES } = require('./lib/postgres-prospect-store');

const app = express();
const port = process.env.PORT || process.env.OUTREACH_PORT || 3001;
const store = new PostgresProspectStore();
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.use(express.json({ limit: '1mb' }));

const defaultPolicy = Object.freeze({
  ruleVersion: '1.5.0',
  minimumIdentityConfidence: 0.6,
  minimumQualificationScore: 52.5,
  minimumPersonalizationScore: 56.25,
  minimumEvidenceCoverage: 0.675,
  minimumEmailConfidence: 60,
  maxDataAgeDays: 30,
  maxContactsPerWindow: 3,
  dailyEmailLimit: Number(process.env.DAILY_EMAIL_LIMIT || 100),
  approvedChannels: ['email', 'sms', 'linkedin', 'manual_call'],
  requiredBusinessFields: ['name', 'domain']
});

app.get('/health', asyncRoute(async (req, res) => {
  const [database, redis] = await Promise.all([databaseHealthcheck(), redisHealthcheck()]);
  res.json({
    status: 'ok',
    service: 'lion-elite-outreach',
    store: 'postgresql',
    queue: 'redis-bullmq',
    ruleVersion: defaultPolicy.ruleVersion,
    capabilities: ['validation','authorization','public_business_email_enrichment','email_generation','postgres_prospect_store','redis_job_queues','distributed_locks','caching','dead_letter_queue','outreach_queue','audit_timeline','daily_email_quota'],
    database,
    redis,
    emailQuota: await store.getDailyEmailQuota(),
    timestamp: new Date().toISOString()
  });
}));

app.post('/api/outreach/fingerprint', (req, res) => res.json({ fingerprint: createBusinessFingerprint(req.body?.business || req.body || {}) }));
app.post('/api/outreach/score', (req, res) => res.json({ score: scoreQualification(req.body?.signals || {}, req.body?.weights || {}) }));
app.post('/api/outreach/validate', (req, res) => {
  const validation = validateProspect(req.body?.prospect || {}, { ...defaultPolicy, ...(req.body?.policy || {}) });
  res.status(validation.passed ? 200 : 422).json({ validation });
});
app.post('/api/outreach/authorize', (req, res) => {
  try { res.json({ authorization: authorizeOutreach(req.body?.prospect || {}, { ...defaultPolicy, ...(req.body?.policy || {}) }) }); }
  catch (error) { res.status(422).json({ error: error.code || 'OUTREACH_BLOCKED', message: error.message, validation: error.validation }); }
});
app.post('/api/outreach/email/generate', (req, res) => {
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };
  const draft = generateEmailDraft(req.body || {});
  const quality = scoreEmailDraft(draft, req.body || {});
  const approved = quality.score >= policy.minimumPersonalizationScore && quality.blockers.length === 0;
  res.status(approved ? 200 : 422).json({ draft, quality, approved });
});
app.post('/api/outreach/email/score', (req, res) => res.json({ quality: scoreEmailDraft(req.body?.draft || {}, req.body?.context || {}) }));
app.get('/api/outreach/quota', asyncRoute(async (req, res) => res.json({ quota: await store.getDailyEmailQuota(req.query?.day) })));

app.post('/api/workflows/outreach', asyncRoute(async (req, res) => {
  const prospect = req.body?.prospect;
  if (!prospect) return res.status(400).json({ error: 'MISSING_PROSPECT' });
  const prospectId = prospect.prospectId || createBusinessFingerprint(prospect.business || prospect);
  const job = await addJob('email', 'generate-personalized-email', {
    ...req.body,
    prospect,
    policy: { ...defaultPolicy, ...(req.body?.policy || {}) }
  }, {
    jobId: `email:${prospectId}:${req.body?.campaignId || prospect.campaignId || 'default'}`
  });
  res.status(202).json({ accepted: true, queue: 'email', jobId: job.id, state: await job.getState() });
}));

app.post('/api/jobs/:queue', asyncRoute(async (req, res) => {
  const job = await addJob(req.params.queue, req.body?.name || 'manual-job', req.body?.data || {}, req.body?.options || {});
  res.status(202).json({ accepted: true, queue: req.params.queue, jobId: job.id, state: await job.getState() });
}));

app.get('/api/metrics/queues', asyncRoute(async (req, res) => res.json({ queues: await queueMetrics() })));

app.post('/api/enrichment/email', asyncRoute(async (req, res) => {
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };
  const result = await enrichBusinessEmail(req.body?.business || {}, { minimumConfidence: policy.minimumEmailConfidence, maxPages: Math.min(Number(req.body?.maxPages || 6), 10) });
  res.status(result.status === 'verified' ? 200 : 422).json({ enrichment: result });
}));
app.post('/api/enrichment/email/batch', asyncRoute(async (req, res) => {
  const businesses = Array.isArray(req.body?.businesses) ? req.body.businesses : [];
  if (!businesses.length) return res.status(400).json({ error: 'MISSING_BUSINESSES' });
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };
  res.json({ enrichment: await enrichBatch(businesses, { minimumConfidence: policy.minimumEmailConfidence, maxPages: Math.min(Number(req.body?.maxPages || 6), 10), maxBatchSize: 25 }) });
}));

app.post('/api/prospects', asyncRoute(async (req, res) => {
  const result = await store.create(req.body || {}, req.get('x-actor-id') || 'api');
  res.status(result.duplicate ? 200 : 201).json(result);
}));
app.get('/api/prospects', asyncRoute(async (req, res) => res.json({ prospects: await store.list(req.query), stages: STAGES })));
app.get('/api/prospects/:id', asyncRoute(async (req, res) => {
  const prospect = await store.get(req.params.id);
  if (!prospect) return res.status(404).json({ error: 'PROSPECT_NOT_FOUND' });
  res.json({ prospect, timeline: await store.timeline(req.params.id) });
}));
app.patch('/api/prospects/:id', asyncRoute(async (req, res) => {
  const prospect = await store.update(req.params.id, req.body, req.get('x-actor-id') || 'api');
  if (!prospect) return res.status(404).json({ error: 'PROSPECT_NOT_FOUND' });
  res.json({ prospect });
}));
app.post('/api/prospects/:id/transition', asyncRoute(async (req, res) => {
  const prospect = await store.transition(req.params.id, req.body?.stage, req.body?.metadata, req.get('x-actor-id') || 'api');
  if (!prospect) return res.status(404).json({ error: 'PROSPECT_NOT_FOUND' });
  res.json({ prospect });
}));
app.post('/api/prospects/:id/queue', asyncRoute(async (req, res) => {
  const result = await store.enqueue(req.params.id, req.body?.authorization, req.body?.message || {}, req.body?.scheduledAt, req.get('x-actor-id') || 'api');
  res.status(result.duplicate ? 200 : 201).json(result);
}));
app.get('/api/outreach/queue', asyncRoute(async (req, res) => res.json({ queue: await store.listQueue(req.query) })));
app.patch('/api/outreach/queue/:id', asyncRoute(async (req, res) => {
  const item = await store.markQueue(req.params.id, req.body?.status, req.body?.metadata, req.get('x-actor-id') || 'api');
  if (!item) return res.status(404).json({ error: 'QUEUE_ITEM_NOT_FOUND' });
  res.json({ item, quota: await store.getDailyEmailQuota() });
}));
app.get('/api/metrics/pipeline', asyncRoute(async (req, res) => res.json({ metrics: await store.metrics() })));

app.use((error, req, res, next) => {
  console.error(error);
  const status = error.code === 'DAILY_EMAIL_QUOTA_REACHED' ? 429 : (error.code ? 422 : 500);
  res.status(status).json({ error: error.code || 'INTERNAL_ERROR', message: error.message || 'The outreach service could not complete the request.' });
});

app.listen(port, () => console.log(`Lion Elite PostgreSQL and Redis outreach service running on port ${port}`));
module.exports = { app, defaultPolicy, store };

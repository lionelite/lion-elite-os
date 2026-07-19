'use strict';

const express = require('express');
const crypto = require('crypto');
const { addJob, queueMetrics } = require('./lib/job-queues');
const { getRedis, ensureConnected } = require('./lib/redis');
const killSwitch = require('./lib/kill-switch');

const app = express();
app.use(express.json({ limit: '256kb' }));

const port = Number(process.env.PORT || 10000);
const apiToken = process.env.EXECUTIVE_API_TOKEN || '';
const allowedJobs = new Set(['morning-brief', 'midday-revenue-check', 'evening-review', 'business-health-snapshot']);

function requireAuth(req, res, next) {
  if (!apiToken) return next();
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const valid = supplied.length === apiToken.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(apiToken));
  if (!valid) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
}

app.get('/health', async (_req, res) => {
  try {
    const redis = await ensureConnected(getRedis());
    await redis.ping();
    res.json({ status: 'ok', service: 'lion-elite-executive-orchestrator', time: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'degraded', error: error.message });
  }
});

app.get('/status', requireAuth, async (_req, res) => {
  const redis = await ensureConnected(getRedis());
  const [metrics, lastReport] = await Promise.all([
    queueMetrics(),
    redis.get('executive:last-report')
  ]);
  res.json({ metrics, lastReport: lastReport ? JSON.parse(lastReport) : null, time: new Date().toISOString() });
});

// Kill-switch routes for automated outreach. Unlike the analytics routes,
// these REQUIRE a configured token: requireAuth alone falls open when
// EXECUTIVE_API_TOKEN is unset, and an unauthenticated resume path would
// defeat the point of a kill switch.
function requireConfiguredAuth(req, res, next) {
  if (!apiToken) return res.status(503).json({ error: 'EXECUTIVE_API_TOKEN_NOT_CONFIGURED' });
  return requireAuth(req, res, next);
}

app.get('/outreach/kill-switch', requireConfiguredAuth, async (_req, res) => {
  res.json(await killSwitch.status());
});

// On-demand leads digest ("what leads are we getting and how do they
// rate"). Token-required: the digest contains prospect names.
app.get('/leads/digest', requireConfiguredAuth, async (_req, res) => {
  try {
    const { buildLeadsDigest } = require('./lib/leads-digest');
    res.json(await buildLeadsDigest());
  } catch (error) {
    res.status(503).json({ error: 'LEADS_DIGEST_UNAVAILABLE', message: error.message });
  }
});

app.post('/outreach/kill-switch', requireConfiguredAuth, async (req, res) => {
  const wantHalted = Boolean(req.body?.halted);
  const result = wantHalted
    ? await killSwitch.halt(String(req.body?.reason || 'manual halt via executive API'), 'executive-api')
    : await killSwitch.resume('executive-api');
  res.json(result);
});

app.post('/run/:job', requireAuth, async (req, res) => {
  const jobName = req.params.job;
  if (!allowedJobs.has(jobName)) return res.status(400).json({ error: 'UNKNOWN_EXECUTIVE_JOB', allowed: [...allowedJobs] });

  const runId = crypto.randomUUID();
  const period = new Date().toISOString().slice(0, 13);
  const job = await addJob('analytics', jobName, {
    runId,
    requestedAt: new Date().toISOString(),
    source: req.body?.source || 'executive-api',
    brands: req.body?.brands || ['lion-elite-wellness', 'lion-elite-beauty'],
    include: req.body?.include || ['queues', 'operations', 'sales', 'content', 'deployments']
  }, {
    jobId: `executive:${jobName}:${period}`,
    removeOnComplete: 250,
    removeOnFail: 500
  });

  res.status(202).json({ accepted: true, runId, jobId: job.id, job: jobName });
});

app.use((error, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', event: 'executive.api.error', message: error.message }));
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

app.listen(port, () => console.log(JSON.stringify({ level: 'info', event: 'executive.api.started', port })));

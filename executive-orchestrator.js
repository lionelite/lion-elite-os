'use strict';

const express = require('express');
const crypto = require('crypto');
const { addJob, queueMetrics } = require('./lib/job-queues');
const { getRedis, ensureConnected } = require('./lib/redis');
const { runExecutiveAgent } = require('./lib/openai-executive-agent');
const { dispatchPlan } = require('./lib/openai-action-dispatcher');

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
    res.json({
      status: 'ok',
      service: 'lion-elite-executive-orchestrator',
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      liveExecution: true,
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ status: 'degraded', error: error.message });
  }
});

app.get('/status', requireAuth, async (_req, res) => {
  const redis = await ensureConnected(getRedis());
  const [metrics, lastReport, lastAiExecution] = await Promise.all([
    queueMetrics(),
    redis.get('executive:last-report'),
    redis.get('executive:last-ai-execution')
  ]);
  res.json({
    metrics,
    lastReport: lastReport ? JSON.parse(lastReport) : null,
    lastAiExecution: lastAiExecution ? JSON.parse(lastAiExecution) : null,
    time: new Date().toISOString()
  });
});

app.post('/ai/command', requireAuth, async (req, res, next) => {
  try {
    const plan = await runExecutiveAgent(req.body || {});
    const result = await dispatchPlan(plan);
    const redis = await ensureConnected(getRedis());
    await redis.set('executive:last-ai-execution', JSON.stringify(result), 'EX', 60 * 60 * 24 * 30);
    await redis.lpush('executive:ai-audit-log', JSON.stringify(result));
    await redis.ltrim('executive:ai-audit-log', 0, 999);
    res.status(202).json(result);
  } catch (error) {
    if (error.code === 'COMMAND_REQUIRED' || error.code === 'COMMAND_TOO_LARGE') {
      return res.status(400).json({ error: error.code });
    }
    if (error.code === 'OPENAI_API_KEY_MISSING') {
      return res.status(503).json({ error: error.code });
    }
    next(error);
  }
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

app.listen(port, () => console.log(JSON.stringify({ level: 'info', event: 'executive.api.started', port, liveExecution: true })));

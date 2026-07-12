'use strict';

const http = require('http');
const { Worker } = require('bullmq');
const { createRedisConnection, healthcheck, withLock } = require('../lib/redis');
const { QUEUE_NAMES, addJob, moveToDeadLetter, queueMetrics } = require('../lib/job-queues');
const { generateEmailDraft, scoreEmailDraft } = require('../lib/email-generator');
const { validateProspect, authorizeOutreach } = require('../lib/outreach-validation');

const workers = [];
const concurrency = Number(process.env.WORKER_CONCURRENCY || 5);

function startWorker(queueName, processor) {
  const worker = new Worker(queueName, async job => {
    return withLock(`job:${queueName}:${job.id}`, () => processor(job), Number(process.env.JOB_LOCK_TTL_MS || 120000));
  }, {
    connection: createRedisConnection(),
    concurrency,
    lockDuration: Number(process.env.JOB_LOCK_TTL_MS || 120000)
  });

  worker.on('failed', async (job, error) => {
    if (job && job.attemptsMade >= Number(job.opts.attempts || 1)) {
      try { await moveToDeadLetter(job, error); }
      catch (deadLetterError) { console.error('Dead-letter write failed', deadLetterError); }
    }
  });

  worker.on('error', error => console.error(`Worker error on ${queueName}`, error));
  workers.push(worker);
  return worker;
}

startWorker(QUEUE_NAMES.email, async job => {
  const context = job.data || {};
  const draft = generateEmailDraft(context);
  const quality = scoreEmailDraft(draft, context);
  const minimumScore = Number(context.minimumPersonalizationScore || process.env.MINIMUM_PERSONALIZATION_SCORE || 56.25);

  if (quality.prohibitedClaims.length || quality.score < minimumScore) {
    const error = new Error('Generated email did not meet quality requirements.');
    error.code = 'EMAIL_QUALITY_BLOCKED';
    error.quality = quality;
    throw error;
  }

  if (context.prospect) {
    await addJob('validation', 'validate-outreach', {
      ...context,
      draft,
      quality
    }, { jobId: `validate:${context.prospect.prospectId || job.id}` });
  }

  return { draft, quality, approved: true };
});

startWorker(QUEUE_NAMES.validation, async job => {
  const context = job.data || {};
  const validation = validateProspect(context.prospect || {}, context.policy || {});
  if (!validation.passed) {
    const error = new Error('Prospect failed outreach validation.');
    error.code = 'OUTREACH_BLOCKED';
    error.validation = validation;
    throw error;
  }

  const authorization = authorizeOutreach(context.prospect, context.policy || {});
  await addJob('dispatch', 'dispatch-authorized-outreach', {
    prospect: context.prospect,
    draft: context.draft,
    quality: context.quality,
    authorization
  }, { jobId: authorization.idempotencyKey });

  return { validation, authorization };
});

startWorker(QUEUE_NAMES.dispatch, async job => {
  // This worker intentionally prepares an authorized dispatch record only.
  // A channel adapter must perform the actual send and then persist the provider result.
  return {
    status: 'authorized_for_delivery',
    authorization: job.data.authorization,
    recipient: job.data.draft?.recipient || job.data.prospect?.contact?.email,
    preparedAt: new Date().toISOString()
  };
});

const healthPort = Number(process.env.WORKER_HEALTH_PORT || process.env.PORT || 10000);
const server = http.createServer(async (req, res) => {
  if (req.url !== '/health' && req.url !== '/metrics') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }

  try {
    const redis = await healthcheck();
    const queues = req.url === '/metrics' ? await queueMetrics() : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'lion-elite-outreach-worker', redis, queues, workers: workers.length }));
  } catch (error) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'degraded', error: error.message }));
  }
});

server.listen(healthPort, () => console.log(`Outreach worker health server listening on ${healthPort}`));

async function shutdown() {
  await Promise.all(workers.map(worker => worker.close()));
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

'use strict';

const http = require('http');
const { Worker } = require('bullmq');
const { createRedisConnection, getRedis, ensureConnected, healthcheck, withLock, closeRedis } = require('../lib/redis');
const { QUEUE_NAMES, addJob, moveToDeadLetter, queueMetrics } = require('../lib/job-queues');
const { buildEmail: generateEmailDraft, scoreEmail: scoreEmailDraft } = require('../lib/email-generation');
const { validateProspect, authorizeOutreach } = require('../lib/outreach-validation');
const { sendEmail } = require('../lib/email-delivery');
const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
const { log, runtimeMetrics } = require('../lib/observability');

const workers = [];
const store = new PostgresProspectStore();
const concurrency = Number(process.env.WORKER_CONCURRENCY || 5);
const heartbeatSeconds = Number(process.env.WORKER_HEARTBEAT_SECONDS || 15);
const queueLagWarning = Number(process.env.QUEUE_LAG_WARNING || 100);
let shuttingDown = false;
let heartbeatTimer;

function startWorker(queueName, processor) {
  const worker = new Worker(queueName, async job => {
    const started = Date.now();
    log('info', 'job.started', { queue: queueName, jobId: job.id, name: job.name });
    try {
      const result = await withLock(`job:${queueName}:${job.id}`, () => processor(job), Number(process.env.JOB_LOCK_TTL_MS || 120000));
      log('info', 'job.completed', { queue: queueName, jobId: job.id, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      log('error', 'job.failed', { queue: queueName, jobId: job.id, durationMs: Date.now() - started, code: error.code, message: error.message });
      throw error;
    }
  }, {
    connection: createRedisConnection(),
    concurrency,
    lockDuration: Number(process.env.JOB_LOCK_TTL_MS || 120000)
  });

  worker.on('failed', async (job, error) => {
    if (job && job.attemptsMade >= Number(job.opts.attempts || 1)) {
      try { await moveToDeadLetter(job, error); }
      catch (deadLetterError) { log('error', 'dead_letter.failed', { queue: queueName, jobId: job?.id, message: deadLetterError.message }); }
    }
  });
  worker.on('error', error => log('error', 'worker.error', { queue: queueName, message: error.message }));
  workers.push(worker);
  return worker;
}

startWorker(QUEUE_NAMES.email, async job => {
  const context = job.data || {};
  const draft = generateEmailDraft(context);
  const quality = scoreEmailDraft(draft, context);
  const minimumScore = Number(context.minimumPersonalizationScore || process.env.MINIMUM_PERSONALIZATION_SCORE || 56.25);
  if (quality.blockers.length || quality.score < minimumScore) {
    const error = new Error('Generated email did not meet quality requirements.');
    error.code = 'EMAIL_QUALITY_BLOCKED'; error.quality = quality; throw error;
  }
  if (context.prospect) await addJob('validation', 'validate-outreach', { ...context, draft, quality }, { jobId: `validate:${context.prospect.prospectId || job.id}` });
  return { draft, quality, approved: true };
});

startWorker(QUEUE_NAMES.validation, async job => {
  const context = job.data || {};

  if (job.name === 'schedule-due-followups') {
    const pending = await store.listQueue({ status: 'pending' });
    const now = Date.now();
    const due = pending
      .filter(item => !item.scheduledAt || new Date(item.scheduledAt).getTime() <= now)
      .slice(0, Number(context.maxProspects || 100));

    let queued = 0;
    for (const item of due) {
      const prospect = await store.get(item.prospectId);
      if (!prospect || prospect.status === 'suppressed') continue;
      await addJob('dispatch', 'dispatch-authorized-outreach', {
        queueId: item.queueId,
        prospect,
        draft: { recipient: item.recipient, subject: item.subject, body: item.body },
        authorization: { authorized: true, idempotencyKey: item.idempotencyKey, validationRunId: item.validationRunId }
      }, { jobId: item.idempotencyKey });
      queued += 1;
    }
    return { examined: pending.length, due: due.length, queued };
  }

  const validation = validateProspect(context.prospect || {}, context.policy || {});
  if (!validation.passed) {
    const error = new Error('Prospect failed outreach validation.');
    error.code = 'OUTREACH_BLOCKED'; error.validation = validation; throw error;
  }
  const authorization = authorizeOutreach(context.prospect, context.policy || {});
  await addJob('dispatch', 'dispatch-authorized-outreach', { prospect: context.prospect, draft: context.draft, quality: context.quality, authorization }, { jobId: authorization.idempotencyKey });
  return { validation, authorization };
});

startWorker(QUEUE_NAMES.dispatch, async job => {
  const context = job.data || {};
  if (context.queueId) await store.markQueue(context.queueId, 'processing', {}, 'outreach-worker');
  try {
    const delivery = await sendEmail({ prospect: context.prospect, draft: context.draft, authorization: context.authorization });
    if (context.queueId) await store.markQueue(context.queueId, 'sent', { providerMessageId: delivery.providerId }, 'outreach-worker');
    return { ...delivery, authorization: context.authorization, quality: context.quality };
  } catch (error) {
    if (context.queueId) {
      await store.markQueue(context.queueId, 'failed', { lastError: `${error.code || 'DELIVERY_FAILED'}: ${error.message}` }, 'outreach-worker').catch(markError => {
        log('error', 'queue.mark_failed', { queueId: context.queueId, message: markError.message });
      });
    }
    throw error;
  }
});

async function heartbeat() {
  const redis = await ensureConnected(getRedis());
  const metrics = await queueMetrics();
  const waiting = Object.values(metrics).reduce((sum, queue) => sum + Number(queue.waiting || 0), 0);
  const payload = { at: new Date().toISOString(), workers: workers.length, concurrency, waiting, ...runtimeMetrics() };
  await redis.set(`heartbeat:${process.env.RENDER_SERVICE_NAME || 'lion-elite-outreach-worker'}`, JSON.stringify(payload), 'EX', heartbeatSeconds * 3);
  if (waiting >= queueLagWarning) log('warn', 'queue.lag_high', { waiting, threshold: queueLagWarning });
}

heartbeatTimer = setInterval(() => heartbeat().catch(error => log('error', 'heartbeat.failed', { message: error.message })), heartbeatSeconds * 1000);
heartbeat().catch(error => log('error', 'heartbeat.failed', { message: error.message }));

const healthPort = Number(process.env.WORKER_HEALTH_PORT || process.env.PORT || 10000);
const server = http.createServer(async (req, res) => {
  if (!['/health','/ready','/metrics'].includes(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }
  try {
    const redis = await healthcheck();
    const queues = req.url === '/metrics' ? await queueMetrics() : undefined;
    const deliveryConfigured = Boolean(process.env.RESEND_API_KEY && process.env.OUTREACH_FROM_EMAIL && String(process.env.OUTREACH_SEND_ENABLED).toLowerCase() === 'true');
    const ready = !shuttingDown && redis.ok && workers.length > 0 && deliveryConfigured;
    const statusCode = req.url === '/ready' && !ready ? 503 : 200;
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ready ? 'ok' : 'degraded', ready, deliveryConfigured, service: 'lion-elite-outreach-worker', redis, queues, workers: workers.length, ...runtimeMetrics() }));
  } catch (error) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'degraded', ready: false, error: error.message }));
  }
});

server.listen(healthPort, () => log('info', 'worker.started', { port: healthPort, concurrency }));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  log('info', 'worker.shutdown_started', { signal });
  await Promise.allSettled(workers.map(worker => worker.close()));
  await closeRedis();
  server.close(() => {
    log('info', 'worker.shutdown_complete', { signal });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_TIMEOUT_MS || 30000)).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', error => log('error', 'process.unhandled_rejection', { message: error?.message || String(error) }));
process.on('uncaughtException', error => { log('error', 'process.uncaught_exception', { message: error.message }); shutdown('uncaughtException'); });

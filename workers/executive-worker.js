'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection, getRedis, ensureConnected, closeRedis } = require('../lib/redis');
const { QUEUE_NAMES, queueMetrics } = require('../lib/job-queues');

const concurrency = Number(process.env.EXECUTIVE_WORKER_CONCURRENCY || 2);
const allowed = new Set(['morning-brief', 'midday-revenue-check', 'evening-review', 'business-health-snapshot', 'daily-executive-report', 'queue-and-data-maintenance']);

function total(metrics, key) {
  return Object.values(metrics).reduce((sum, value) => sum + Number(value[key] || 0), 0);
}

function healthScore(metrics) {
  const failed = total(metrics, 'failed');
  const waiting = total(metrics, 'waiting');
  const active = total(metrics, 'active');
  return Math.max(0, Math.min(100, 100 - Math.min(40, failed * 4) - Math.min(30, waiting / 5) + Math.min(5, active)));
}

const worker = new Worker(QUEUE_NAMES.analytics, async job => {
  if (!allowed.has(job.name)) throw Object.assign(new Error(`Unsupported executive job: ${job.name}`), { code: 'UNSUPPORTED_EXECUTIVE_JOB' });

  const metrics = await queueMetrics();
  const report = {
    runId: job.data?.runId || String(job.id),
    type: job.name,
    generatedAt: new Date().toISOString(),
    businessHealthScore: Math.round(healthScore(metrics)),
    summary: {
      waiting: total(metrics, 'waiting'),
      active: total(metrics, 'active'),
      completed: total(metrics, 'completed'),
      failed: total(metrics, 'failed'),
      delayed: total(metrics, 'delayed')
    },
    priorities: [],
    metrics
  };

  if (report.summary.failed > 0) report.priorities.push({ priority: 'critical', action: 'Review failed automation jobs and dead-letter queue.' });
  if (report.summary.waiting > Number(process.env.EXECUTIVE_QUEUE_WARNING || 100)) report.priorities.push({ priority: 'high', action: 'Reduce queue backlog or increase worker concurrency.' });
  if (!report.priorities.length) report.priorities.push({ priority: 'normal', action: 'Automation infrastructure is operating within configured thresholds.' });

  const redis = await ensureConnected(getRedis());
  await redis.set('executive:last-report', JSON.stringify(report));
  await redis.lpush('executive:report-history', JSON.stringify(report));
  await redis.ltrim('executive:report-history', 0, 99);
  console.log(JSON.stringify({ level: 'info', event: 'executive.report.generated', report }));
  return report;
}, {
  connection: createRedisConnection(),
  concurrency,
  lockDuration: Number(process.env.JOB_LOCK_TTL_MS || 120000)
});

worker.on('failed', (job, error) => console.error(JSON.stringify({ level: 'error', event: 'executive.job.failed', jobId: job?.id, name: job?.name, message: error.message })));
worker.on('error', error => console.error(JSON.stringify({ level: 'error', event: 'executive.worker.error', message: error.message })));

async function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'executive.worker.shutdown', signal }));
  await worker.close();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.log(JSON.stringify({ level: 'info', event: 'executive.worker.started', concurrency }));

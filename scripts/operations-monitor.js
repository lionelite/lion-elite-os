'use strict';

const { getRedis, ensureConnected, healthcheck: redisHealthcheck, closeRedis } = require('../lib/redis');
const { healthcheck: databaseHealthcheck, close: closeDatabase } = require('../lib/database');
const { queueMetrics } = require('../lib/job-queues');
const { log } = require('../lib/observability');

const queueWarning = Number(process.env.QUEUE_LAG_WARNING || 100);
const failedWarning = Number(process.env.FAILED_JOB_WARNING || 10);
const heartbeatMaxAge = Number(process.env.WORKER_HEARTBEAT_MAX_AGE_SECONDS || 60);
const workerKey = `heartbeat:${process.env.MONITORED_WORKER_NAME || 'lion-elite-outreach-worker'}`;

async function run() {
  const [database, redis, queues] = await Promise.all([
    databaseHealthcheck(),
    redisHealthcheck(),
    queueMetrics()
  ]);

  const client = await ensureConnected(getRedis());
  const rawHeartbeat = await client.get(workerKey);
  const heartbeat = rawHeartbeat ? JSON.parse(rawHeartbeat) : null;
  const heartbeatAge = heartbeat?.at ? Math.floor((Date.now() - new Date(heartbeat.at).getTime()) / 1000) : null;
  const totals = Object.values(queues).reduce((acc, queue) => {
    acc.waiting += Number(queue.waiting || 0);
    acc.active += Number(queue.active || 0);
    acc.failed += Number(queue.failed || 0);
    acc.delayed += Number(queue.delayed || 0);
    return acc;
  }, { waiting: 0, active: 0, failed: 0, delayed: 0 });

  const alerts = [];
  if (!database.ok) alerts.push({ type: 'database_unhealthy' });
  if (!redis.ok) alerts.push({ type: 'redis_unhealthy' });
  if (!heartbeat || heartbeatAge > heartbeatMaxAge) alerts.push({ type: 'worker_heartbeat_stale', heartbeatAge, threshold: heartbeatMaxAge });
  if (totals.waiting >= queueWarning) alerts.push({ type: 'queue_backlog_high', waiting: totals.waiting, threshold: queueWarning });
  if (totals.failed >= failedWarning) alerts.push({ type: 'failed_jobs_high', failed: totals.failed, threshold: failedWarning });

  const payload = { database, redis, heartbeat, heartbeatAge, totals, queues, alerts };
  log(alerts.length ? 'warn' : 'info', 'operations.monitor', payload);
  await client.set('ops:last-check', JSON.stringify({ ...payload, checkedAt: new Date().toISOString() }), 'EX', 900);
  if (alerts.length) process.exitCode = 2;
}

run()
  .catch(error => {
    log('error', 'operations.monitor_failed', { message: error.message, stack: error.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeRedis(), closeDatabase()]);
  });

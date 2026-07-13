'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection, ensureConnected, getRedis, closeRedis } = require('../lib/redis');
const { QUEUE_NAMES, addJob, moveToDeadLetter } = require('../lib/job-queues');

const concurrency = Number(process.env.INTEGRATION_WORKER_CONCURRENCY || 5);
let shuttingDown = false;

function summarize(source, type, payload) {
  if (source === 'shopify') {
    return {
      orderId: payload?.id || payload?.order_id || null,
      customerEmail: payload?.email || payload?.customer?.email || null,
      total: Number(payload?.current_total_price || payload?.total_price || 0),
      currency: payload?.currency || null,
      financialStatus: payload?.financial_status || null
    };
  }
  if (source === 'gmail') {
    return {
      messageId: payload?.messageId || payload?.id || null,
      from: payload?.from || null,
      subject: payload?.subject || null,
      intent: payload?.intent || null,
      urgency: payload?.urgency || null
    };
  }
  if (source === 'calendar') {
    return {
      eventId: payload?.eventId || payload?.id || null,
      title: payload?.title || payload?.summary || null,
      startsAt: payload?.startsAt || payload?.start?.dateTime || payload?.start || null,
      attendeeCount: Array.isArray(payload?.attendees) ? payload.attendees.length : null
    };
  }
  if (source === 'ads') {
    return {
      campaignId: payload?.campaignId || payload?.campaign_id || null,
      spend: Number(payload?.spend || 0),
      revenue: Number(payload?.revenue || payload?.conversionValue || 0),
      leads: Number(payload?.leads || 0)
    };
  }
  return { keys: Object.keys(payload || {}).slice(0, 20) };
}

function classify(source, type, payload) {
  const normalizedType = String(type || '').toLowerCase();
  if (source === 'shopify' && (normalizedType.includes('order') || payload?.total_price)) return 'revenue';
  if (source === 'gmail') return 'lead_or_support';
  if (source === 'calendar') return 'appointment';
  if (source === 'ads') return 'marketing_performance';
  return 'general';
}

const worker = new Worker(QUEUE_NAMES.integrations, async job => {
  const redis = await ensureConnected(getRedis());
  const event = job.data || {};
  const record = {
    eventId: event.eventId,
    source: event.source,
    eventType: event.eventType,
    category: classify(event.source, event.eventType, event.payload),
    summary: summarize(event.source, event.eventType, event.payload),
    metadata: event.metadata || {},
    receivedAt: event.receivedAt,
    processedAt: new Date().toISOString()
  };

  const encoded = JSON.stringify(record);
  await redis.multi()
    .lpush('integrations:events', encoded)
    .ltrim('integrations:events', 0, 999)
    .hset('integrations:latest', event.source, encoded)
    .hincrby('integrations:counts', event.source, 1)
    .exec();

  const executiveJob = record.category === 'revenue'
    ? 'midday-revenue-check'
    : record.category === 'lead_or_support'
      ? 'business-health-snapshot'
      : null;

  if (executiveJob) {
    await addJob('executive', executiveJob, {
      trigger: 'integration-event',
      sourceEvent: record,
      generatedAt: new Date().toISOString()
    }, { jobId: `executive:${record.eventId}` });
  }

  return record;
}, {
  connection: createRedisConnection(),
  concurrency,
  lockDuration: Number(process.env.JOB_LOCK_TTL_MS || 120000)
});

worker.on('failed', async (job, error) => {
  console.error(JSON.stringify({ level: 'error', event: 'integration.failed', jobId: job?.id, message: error.message }));
  if (job && job.attemptsMade >= Number(job.opts.attempts || 1)) await moveToDeadLetter(job, error).catch(() => {});
});
worker.on('error', error => console.error(JSON.stringify({ level: 'error', event: 'integration.worker_error', message: error.message })));
console.log(JSON.stringify({ level: 'info', event: 'integration.worker_started', concurrency }));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'integration.worker_shutdown', signal }));
  await worker.close();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

'use strict';

const { Worker } = require('bullmq');
const { createRedisConnection, ensureConnected, getRedis, closeRedis } = require('../lib/redis');
const { QUEUE_NAMES, addJob, moveToDeadLetter } = require('../lib/job-queues');
const { summarize, classify, recordAffiliateLead, recordStripeSubscription } = require('../lib/integration-normalization');
const { isOrderEvent, brandFromEvent, buildOrderNotification } = require('../lib/orders/order-notification');
const { sendOrderNotification } = require('../lib/orders/notify-transport');

const concurrency = Number(process.env.INTEGRATION_WORKER_CONCURRENCY || 5);
let shuttingDown = false;

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

  let affiliateResult = null;
  if (record.category === 'affiliate_lead') {
    affiliateResult = await recordAffiliateLead(record);
    record.affiliate = affiliateResult;
  }

  if (record.source === 'stripe') {
    const result = await recordStripeSubscription(record);
    record.subscription = {
      duplicate: result.duplicate,
      tracked: result.tracked,
      eventType: result.eventType,
      status: result.status || null
    };
    record.summary = {
      ...record.summary,
      customerId: record.summary.customerId ? '[redacted]' : null,
      customerEmail: record.summary.customerEmail ? '[redacted]' : null
    };
  }

  // Internal owner order-notification (the "NEW ORDER — ACTION REQUIRED" email)
  // for Shopify/Stripe order webhooks — fail-closed + non-fatal so a missing
  // switch or a provider hiccup never blocks order processing.
  if (isOrderEvent(event.source, event.eventType)) {
    try {
      const brandKey = brandFromEvent(event);
      const notification = buildOrderNotification(event.source, event.payload || {}, { brandKey });
      const sent = await sendOrderNotification(notification);
      record.orderNotification = { brand: brandKey, orderId: notification.order.orderId, status: sent.status };
    } catch (error) {
      record.orderNotification = { status: 'error', message: error.message };
    }
  }

  const encoded = JSON.stringify(record);
  await redis.multi()
    .lpush('integrations:events', encoded)
    .ltrim('integrations:events', 0, 999)
    .hset('integrations:latest', event.source, encoded)
    .hincrby('integrations:counts', event.source, 1)
    .exec();

  const executiveJob = ['revenue', 'subscription_revenue'].includes(record.category)
    ? 'midday-revenue-check'
    : ['lead_or_support', 'retention_risk'].includes(record.category)
      ? 'business-health-snapshot'
      : null;

  if (affiliateResult?.suppressed) {
    return record;
  }

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

'use strict';

const { Queue } = require('bullmq');
const { createRedisConnection } = require('./redis');

const QUEUE_NAMES = Object.freeze({
  discovery: 'prospect-discovery',
  research: 'prospect-research',
  enrichment: 'prospect-enrichment',
  qualification: 'prospect-qualification',
  personalization: 'prospect-personalization',
  email: 'email-generation',
  validation: 'outreach-validation',
  dispatch: 'outreach-dispatch',
  analytics: 'outreach-analytics',
  executive: 'executive-automation',
  integrations: 'integration-events',
  deadLetter: 'dead-letter'
});

let connection;
let queues;

function getConnection() {
  if (!connection) connection = createRedisConnection();
  return connection;
}

function buildQueue(name) {
  return new Queue(name, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: Number(process.env.JOB_ATTEMPTS || 4),
      backoff: { type: 'exponential', delay: Number(process.env.JOB_BACKOFF_MS || 5000) },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: false
    }
  });
}

function getQueues() {
  if (!queues) {
    queues = Object.fromEntries(Object.entries(QUEUE_NAMES).map(([key, name]) => [key, buildQueue(name)]));
  }
  return queues;
}

/**
 * BullMQ (5.x) throws "Custom Id cannot contain :" for any custom jobId that
 * contains ':' unless it splits into exactly three parts (a legacy repeatable-
 * job format). Several producers built two-part ids — `validate:<prospectId>`
 * in the outreach worker, `executive:<eventId>` in the integration worker,
 * `reachout:<prospectId>` in scripts/enqueue-outreach.js, `<queue>:<jobId>` for
 * dead letters — so each of those adds threw, and the outreach pipeline could
 * never get a draft past the email stage. Normalizing here covers every caller,
 * and because the mapping is deterministic, idempotent dedupe still holds.
 */
function safeJobId(jobId) {
  if (jobId === undefined || jobId === null) return undefined;
  return String(jobId).replace(/:/g, '-');
}

// Callers have passed both forms: keys ('analytics') and names
// (QUEUE_NAMES.analytics === 'outreach-analytics'). Only keys resolved, so every
// scheduled task in scripts/cron-scheduler.js (which uses names) failed with
// "Unknown queue" on every run: discovery, follow-ups, analytics, the briefs.
// Accepting either form fixes every caller in one place.
const KEY_BY_NAME = Object.freeze(Object.fromEntries(Object.entries(QUEUE_NAMES).map(([key, name]) => [name, key])));

function resolveQueueKey(queueKeyOrName) {
  if (Object.prototype.hasOwnProperty.call(QUEUE_NAMES, queueKeyOrName)) return queueKeyOrName;
  return KEY_BY_NAME[queueKeyOrName];
}

async function addJob(queueKeyOrName, name, data, options = {}) {
  const queueKey = resolveQueueKey(queueKeyOrName);
  const queue = queueKey && getQueues()[queueKey];
  if (!queue) {
    const error = new Error(`Unknown queue: ${queueKeyOrName}`);
    error.code = 'UNKNOWN_QUEUE';
    throw error;
  }

  return queue.add(name, data, {
    delay: options.delay || 0,
    priority: options.priority,
    ...options,
    jobId: safeJobId(options.jobId)
  });
}

async function moveToDeadLetter(job, error) {
  return getQueues().deadLetter.add('failed-job', {
    sourceQueue: job.queueName,
    sourceJobId: job.id,
    name: job.name,
    data: job.data,
    attemptsMade: job.attemptsMade,
    failedReason: error?.message || String(error),
    failedAt: new Date().toISOString()
  }, {
    jobId: safeJobId(`${job.queueName}:${job.id}`),
    attempts: 1
  });
}

async function queueMetrics() {
  const result = {};
  for (const [key, queue] of Object.entries(getQueues())) {
    result[key] = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  }
  return result;
}

async function closeQueues() {
  if (!queues) return;
  await Promise.all(Object.values(queues).map(queue => queue.close()));
  queues = null;
  // BullMQ does not close a connection it was handed, so without this every
  // script that enqueues (scripts/enqueue-outreach.js, the cron scheduler)
  // kept the process alive after finishing and had to be killed.
  if (connection) await connection.quit().catch(() => connection.disconnect());
  connection = null;
}

module.exports = { QUEUE_NAMES, getQueues, addJob, moveToDeadLetter, queueMetrics, closeQueues, safeJobId, resolveQueueKey };

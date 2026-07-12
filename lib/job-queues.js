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

async function addJob(queueKey, name, data, options = {}) {
  const queue = getQueues()[queueKey];
  if (!queue) {
    const error = new Error(`Unknown queue: ${queueKey}`);
    error.code = 'UNKNOWN_QUEUE';
    throw error;
  }

  return queue.add(name, data, {
    jobId: options.jobId,
    delay: options.delay || 0,
    priority: options.priority,
    ...options
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
    jobId: `${job.queueName}:${job.id}`,
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
  connection = null;
}

module.exports = { QUEUE_NAMES, getQueues, addJob, moveToDeadLetter, queueMetrics, closeQueues };

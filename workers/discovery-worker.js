'use strict';

// Consumes the prospect-discovery queue.
//
// scripts/cron-scheduler.js has enqueued 'scheduled-business-discovery' every
// four hours since it was written, and nothing has ever read that queue — the
// jobs simply accumulated. This is the missing consumer.

const { Worker } = require('bullmq');
const { createRedisConnection, closeRedis } = require('../lib/redis');
const { QUEUE_NAMES } = require('../lib/job-queues');
const { runDiscovery } = require('../lib/discovery/discovery-run');
const { enrichBusinessEmail } = require('../lib/email-enrichment');
const { PostgresProspectStore } = require('../lib/postgres-prospect-store');

const concurrency = Number(process.env.DISCOVERY_WORKER_CONCURRENCY || 1);
const allowed = new Set(['scheduled-business-discovery']);
const store = new PostgresProspectStore();

// Rotates the search area per run so repeated passes do not re-walk one city.
let runCount = 0;

const worker = new Worker(QUEUE_NAMES.discovery, async job => {
  if (!allowed.has(job.name)) {
    throw Object.assign(new Error(`Unsupported discovery job: ${job.name}`), { code: 'UNSUPPORTED_DISCOVERY_JOB' });
  }

  const summary = await runDiscovery({
    rotation: runCount++,
    batchSize: Number(job.data?.batchSize || 25),
    categories: job.data?.categories,
    enrichEmail: business => enrichBusinessEmail(business),
    saveProspect: input => store.create(input, 'discovery-worker')
  });

  return summary;
}, {
  connection: createRedisConnection(),
  // One at a time by default: Overpass is a donated shared service and the
  // sites being read for a published address are small businesses' own servers.
  concurrency
});

worker.on('completed', job => console.log(`[discovery-worker] ${job.name} completed`));
worker.on('failed', (job, error) => console.error(`[discovery-worker] ${job?.name} failed: ${error.message}`));

async function shutdown() {
  await worker.close();
  await closeRedis();
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);

console.log(`[discovery-worker] listening on ${QUEUE_NAMES.discovery} (concurrency ${concurrency})`);

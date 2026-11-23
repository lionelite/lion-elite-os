'use strict';

// Declarative map of which worker consumes which queue, and which job names it
// accepts. Dependency-free so tests can read it without bullmq or Redis.
//
// WHY THIS EXISTS. This repo has had the same bug three times — a producer
// naming something the consumer does not answer to, invisible because nothing
// tested both sides of the boundary:
//
//   1. `require('./lib/email-generator')` — module never existed.
//   2. writes to `audit_events.event_type` — table and column never existed.
//   3. `addJob('executive', 'midday-revenue-check')` — executive-worker listens
//      on `analytics`, so every cascaded revenue and lead/retention event was
//      enqueued and never processed.
//
// The first attempt at a guard parsed the worker files with regexes, and missed
// `outreach-worker.js` entirely because it subscribes through a
// `startWorker(QUEUE_NAMES.email, ...)` helper rather than a literal
// `new Worker(QUEUE_NAMES.x)`. A brittle guard that silently under-reports is
// worse than no guard — the same lesson as the phantom authorization gate. So
// consumption is declared here instead of inferred, and
// `test/queue-producer-consumer.test.js` checks the declaration against the
// worker sources in both directions.
//
// Keep this in step when a worker is added, removed, or re-pointed.

const WORKER_CONSUMERS = Object.freeze([
  Object.freeze({
    worker: 'workers/outreach-worker.js',
    queue: 'email',
    // No explicit job allowlist in that stage; it handles whatever arrives.
    jobs: null,
  }),
  Object.freeze({ worker: 'workers/outreach-worker.js', queue: 'validation', jobs: null }),
  Object.freeze({ worker: 'workers/outreach-worker.js', queue: 'dispatch', jobs: null }),
  Object.freeze({
    worker: 'workers/discovery-worker.js',
    queue: 'discovery',
    jobs: Object.freeze(['scheduled-business-discovery']),
  }),
  Object.freeze({
    worker: 'workers/executive-worker.js',
    queue: 'analytics',
    jobs: Object.freeze([
      'morning-brief',
      'midday-revenue-check',
      'evening-review',
      'business-health-snapshot',
      'daily-executive-report',
      'queue-and-data-maintenance',
    ]),
  }),
  Object.freeze({ worker: 'workers/integration-worker.js', queue: 'integrations', jobs: null }),
]);

/**
 * Queues that something produces to but nothing consumes. Each is a real gap
 * needing an owner decision — write the worker, or stop producing — and they are
 * listed so anything NEW fails loudly instead of joining them quietly.
 *
 *   research / enrichment / qualification — three of the dispatcher's allowlisted
 *     actions target these. `enrichment` additionally receives the `staleData`
 *     cron's `refresh-stale-prospect-data` every day, so that scheduled job has
 *     been piling up unprocessed.
 *   executive — `generate-social-content` targets it. Nothing else does any more:
 *     the integration cascade used to, which was bug #3.
 */
const KNOWN_ORPHAN_QUEUES = Object.freeze(['research', 'enrichment', 'qualification', 'executive']);

function consumersFor(queue) {
  return WORKER_CONSUMERS.filter((c) => c.queue === queue);
}

function consumedQueues() {
  return [...new Set(WORKER_CONSUMERS.map((c) => c.queue))];
}

/**
 * Would a job produced to this queue with this name actually be handled?
 *
 * Distinguishes the two failure modes, because they need different fixes: no
 * consumer at all, versus a consumer that rejects the name.
 */
function jobDeliverability(queue, job) {
  const listening = consumersFor(queue);
  if (listening.length === 0) {
    return { deliverable: false, reason: 'no-consumer', detail: `No worker consumes the "${queue}" queue.` };
  }
  const accepting = listening.filter((c) => c.jobs === null || c.jobs.includes(job));
  if (accepting.length === 0) {
    return {
      deliverable: false,
      reason: 'name-rejected',
      detail: `${listening.map((c) => c.worker).join(', ')} consume "${queue}" but do not accept job name "${job}".`,
    };
  }
  return { deliverable: true, reason: 'accepted', by: accepting.map((c) => c.worker) };
}

module.exports = {
  WORKER_CONSUMERS,
  KNOWN_ORPHAN_QUEUES,
  consumersFor,
  consumedQueues,
  jobDeliverability,
};

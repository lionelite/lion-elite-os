'use strict';

const crypto = require('crypto');
const { addJob, QUEUE_NAMES, queueMetrics, closeQueues } = require('../lib/job-queues');

const includeAbundanceMindset = process.env.MORNING_BRIEF_INCLUDE_ABUNDANCE_MINDSET !== 'false';

const JOBS = Object.freeze({
  discovery: {
    queue: QUEUE_NAMES.discovery,
    name: 'scheduled-business-discovery',
    payload: { sourcePolicy: 'approved_public_business_sources', batchSize: 25 }
  },
  staleData: {
    queue: QUEUE_NAMES.enrichment,
    name: 'refresh-stale-prospect-data',
    payload: { maxAgeDays: 30, batchSize: 50, refreshOnly: true }
  },
  followups: {
    queue: QUEUE_NAMES.validation,
    name: 'schedule-due-followups',
    payload: { dueOnly: true, maxProspects: 100, enforceSuppression: true }
  },
  analytics: {
    queue: QUEUE_NAMES.analytics,
    name: 'daily-executive-report',
    payload: { period: 'previous_24_hours', includeQueueHealth: true }
  },
  cleanup: {
    queue: QUEUE_NAMES.analytics,
    name: 'queue-and-data-maintenance',
    payload: { pruneCompletedAfterDays: 14, pruneFailedAfterDays: 30 }
  },
  morningBrief: {
    queue: QUEUE_NAMES.analytics,
    name: 'morning-brief',
    payload: {
      brands: ['lion-elite-wellness', 'lion-elite-beauty'],
      include: ['mindset', 'queues', 'operations', 'sales', 'content', 'deployments'],
      mindset: includeAbundanceMindset ? {
        mode: 'abundance',
        source: 'docs/abundance-mindset-operating-system.md',
        language: 'present-tense-embodied',
        opening: 'daily-mantra',
        requireActionAlignment: true,
        factualReportingMustRemainExact: true
      } : null
    }
  },
  middayRevenue: {
    queue: QUEUE_NAMES.analytics,
    name: 'midday-revenue-check',
    payload: { brands: ['lion-elite-wellness', 'lion-elite-beauty'], include: ['sales', 'leads', 'orders', 'followups'] }
  },
  eveningReview: {
    queue: QUEUE_NAMES.analytics,
    name: 'evening-review',
    payload: { brands: ['lion-elite-wellness', 'lion-elite-beauty'], include: ['completed', 'failed', 'tomorrow-priorities'] }
  },
  healthSnapshot: {
    queue: QUEUE_NAMES.analytics,
    name: 'business-health-snapshot',
    payload: { include: ['queues', 'workers', 'failures', 'backlog'] }
  }
});

async function main() {
  const key = process.argv[2] || process.env.CRON_JOB;
  const definition = JOBS[key];
  if (!definition) {
    throw new Error(`Unknown CRON_JOB: ${key || '(missing)'}. Allowed: ${Object.keys(JOBS).join(', ')}`);
  }

  const runId = crypto.randomUUID();
  const dailyJobs = new Set(['analytics', 'cleanup', 'morningBrief', 'middayRevenue', 'eveningReview']);
  const periodKey = dailyJobs.has(key)
    ? new Date().toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 13);

  const job = await addJob(definition.queue, definition.name, {
    ...definition.payload,
    source: 'render-cron',
    runId,
    triggeredAt: new Date().toISOString()
  }, {
    jobId: `cron:${key}:${periodKey}`,
    removeOnComplete: 500,
    removeOnFail: 1000
  });

  const metrics = await queueMetrics();
  console.log(JSON.stringify({ ok: true, cronJob: key, runId, jobId: job.id, metrics }, null, 2));
  await closeQueues();
}

main().catch(async error => {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || 'CRON_FAILED' }));
  try { await closeQueues(); } catch {}
  process.exit(1);
});

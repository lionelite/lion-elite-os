#!/usr/bin/env node
'use strict';

// Governed "reach out to all" — feed every eligible prospect into the
// validated outreach pipeline. Dry run by default: shows exactly who WOULD
// be contacted and why others are skipped. Nothing is enqueued without
// --confirm, nothing sends without the worker's per-prospect validation +
// daily quota + kill switch, and a run is capped by --limit.
//
//   node scripts/enqueue-outreach.js                 # dry run, all eligible
//   node scripts/enqueue-outreach.js --limit=15      # dry run, top 15 by score
//   node scripts/enqueue-outreach.js --confirm --limit=15   # actually enqueue 15
//
// Requires DATABASE_URL + REDIS_URL. Refuses to run while the kill switch
// is engaged. This does NOT bypass the deliverability ramp — reach out to
// all by running it at your daily cap; the pipeline meters the actual sends.

const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
const { selectOutreachCandidates, buildEmailJobContext } = require('../lib/outreach-enqueue');
const { addJob, QUEUE_NAMES, closeQueues } = require('../lib/job-queues');
const { isHalted, status: killStatus } = require('../lib/kill-switch');
const { closeRedis } = require('../lib/redis');

function parseArgs(argv) {
  const args = { confirm: false, limit: null, campaign: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--confirm') args.confirm = true;
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--campaign=')) args.campaign = arg.slice('--campaign='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.limit != null && (!Number.isFinite(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive number');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const store = new PostgresProspectStore();

  if (await isHalted()) {
    console.error('[reach] Kill switch is ENGAGED — refusing to enqueue.', JSON.stringify(await killStatus()));
    process.exitCode = 1;
    return;
  }

  const filters = args.campaign ? { campaignId: args.campaign } : {};
  const prospects = await store.list(filters);
  const { eligible, skipped } = selectOutreachCandidates(prospects);
  const selected = args.limit ? eligible.slice(0, args.limit) : eligible;

  console.log(`[reach] ${prospects.length} prospect(s) examined · ${eligible.length} eligible · ${skipped.length} skipped`);
  const skipReasons = skipped.reduce((acc, s) => { acc[s.reason] = (acc[s.reason] || 0) + 1; return acc; }, {});
  if (skipped.length) console.log('[reach] skipped by reason:', JSON.stringify(skipReasons));
  console.log(`[reach] would enqueue ${selected.length}${args.limit ? ` (capped at ${args.limit})` : ''}:`);
  for (const p of selected.slice(0, 50)) {
    console.log(`  - ${(p.business && p.business.name) || p.prospectId} · score ${p.score ?? '—'} · ${p.contact.email}`);
  }
  if (selected.length > 50) console.log(`  … and ${selected.length - 50} more`);

  if (!args.confirm) {
    console.log('\n[reach] DRY RUN. No jobs enqueued. Re-run with --confirm to feed these into the validated pipeline.');
    console.log('[reach] Remember: the pipeline meters real sends by the daily quota — this does not blast.');
    return;
  }

  let enqueued = 0;
  for (const prospect of selected) {
    const context = buildEmailJobContext(prospect);
    await addJob(QUEUE_NAMES.email, 'generate-outreach-email', context, {
      jobId: `reachout:${prospect.prospectId}`
    });
    enqueued += 1;
  }
  console.log(`\n[reach] Enqueued ${enqueued} prospect(s) into '${QUEUE_NAMES.email}'.`);
  console.log('[reach] Each will be validated per-prospect; dispatch is metered by the daily quota and the kill switch.');
}

main()
  .catch((error) => {
    console.error(`[reach] FATAL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
  });

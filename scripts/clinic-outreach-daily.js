#!/usr/bin/env node
'use strict';

// Daily clinic outreach: pick today's first-touch clinics and feed them into
// the validated pipeline.
//
//   npm run outreach:clinics                 # dry run: who would go today, and why others would not
//   npm run outreach:clinics -- --confirm    # enqueue them (what the Render cron runs)
//   npm run outreach:clinics -- --limit=10
//
// Selection runs lib/outreach/clinic-qualification.js against live database
// facts, so only clinics that would pass the 16 checks are picked, and the
// worker re-qualifies each one again immediately before validation.
//
// Fail-closed:
//   - With --confirm it does NOTHING unless OUTREACH_SEND_ENABLED=true and the
//     Resend settings exist. Enqueueing while sending is off would mark clinics
//     as contacted (cadence) without anything being sent, burning them.
//   - It does nothing while the kill switch is engaged.
//   - It never takes more than today's remaining DAILY_EMAIL_LIMIT, and never
//     more than OUTREACH_DAILY_NEW_CLINICS (default 20) new clinics per day,
//     which is the deliverability ramp for a new sending domain.

const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
const { qualifyClinicProspect } = require('../lib/outreach/clinic-qualification');
const { buildEmailJobContext } = require('../lib/outreach-enqueue');
const { isClinicSupply } = require('../lib/outreach/draft-router');
const { addJob, closeQueues } = require('../lib/job-queues');
const { isHalted } = require('../lib/kill-switch');
const { closeRedis, getRedis, ensureConnected } = require('../lib/redis');
const { close: closeDb } = require('../lib/database');

const CAMPAIGNS = ['osm-business-discovery', 'med_spa_research_supply'];

function args(argv) {
  const out = { confirm: false, limit: null };
  for (const a of argv.slice(2)) {
    if (a === '--confirm') out.confirm = true;
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice(8));
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const HEARTBEAT_KEY = `heartbeat:${process.env.OUTREACH_WORKER_SERVICE_NAME || 'lion-elite-outreach-worker'}`;

/**
 * Is the outreach worker up and able to send? Read from the heartbeat it writes
 * every few seconds, so this cron never needs the Resend key. A missing or stale
 * heartbeat counts as "no": enqueueing with nobody able to send would mark
 * clinics as contacted while nothing went out.
 */
async function workerCanSend() {
  const raw = await (await ensureConnected(getRedis())).get(HEARTBEAT_KEY);
  if (!raw) return { ok: false, reason: 'the outreach worker is not running (no heartbeat)' };
  const beat = JSON.parse(raw);
  if (!beat.deliveryConfigured) {
    return { ok: false, reason: 'the outreach worker is running but sending is not set up (OUTREACH_SEND_ENABLED, RESEND_API_KEY, OUTREACH_FROM_EMAIL, OUTREACH_POSTAL_ADDRESS)' };
  }
  return { ok: true };
}

async function main() {
  const opts = args(process.argv);
  const store = new PostgresProspectStore();

  if (opts.confirm) {
    const ready = await workerCanSend();
    if (!ready.ok) {
      console.log(`[clinics] Not sending today: ${ready.reason}. Nothing enqueued; no clinic is marked contacted.`);
      return;
    }
    if (await isHalted()) {
      console.log('[clinics] Kill switch engaged. Nothing enqueued.');
      return;
    }
  }

  const quota = await store.getDailyEmailQuota();
  const cap = Math.min(
    Number(process.env.OUTREACH_DAILY_NEW_CLINICS || 20),
    quota.remaining,
    opts.limit || Infinity
  );

  const candidates = [];
  for (const campaignId of CAMPAIGNS) candidates.push(...await store.list({ campaignId, stage: 'discovered' }));
  // Freshest first: a recently confirmed contact is the one most likely to be right.
  candidates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const picked = [];
  const reasons = {};
  // One organisation per day: two locations of one clinic share an inbox domain,
  // and neither is "already contacted" until the other is queued, so without
  // this both could be picked in the same run.
  const domainsToday = new Set();
  for (const prospect of candidates) {
    if (picked.length >= cap) break;
    if (!prospect.contact?.email) { reasons['no e-mail'] = (reasons['no e-mail'] || 0) + 1; continue; }
    const domain = String(prospect.contact.email).toLowerCase().split('@')[1];
    if (domainsToday.has(domain)) { reasons['same organisation already picked today'] = (reasons['same organisation already picked today'] || 0) + 1; continue; }
    const context = buildEmailJobContext(prospect);
    if (!isClinicSupply(context)) { reasons['not a clinic'] = (reasons['not a clinic'] || 0) + 1; continue; }
    const result = qualifyClinicProspect(prospect, await store.contactFacts(prospect));
    if (!result.qualified) {
      for (const b of result.blockers) { const k = b.split(':')[0]; reasons[k] = (reasons[k] || 0) + 1; }
      continue;
    }
    domainsToday.add(domain);
    picked.push({ prospect, context, subject: result.draft.subject });
  }

  console.log(`[clinics] ${candidates.length} discovered prospect(s) examined. Today's cap: ${cap} (daily limit ${quota.limit}, ${quota.sent} sent today).`);
  console.log(`[clinics] ${picked.length} qualify for a first e-mail today:`);
  for (const p of picked) console.log(`  - ${p.prospect.business.name} <${p.prospect.contact.email}>  "${p.subject}"`);
  if (Object.keys(reasons).length) console.log(`[clinics] Not picked (count per failing check): ${JSON.stringify(reasons)}`);

  if (!opts.confirm) {
    console.log('[clinics] DRY RUN. Nothing enqueued. --confirm enqueues them (only when sending is set up).');
    return;
  }
  for (const p of picked) {
    await addJob('email', 'generate-outreach-email', p.context, { jobId: `clinic:${p.prospect.prospectId}:step1` });
  }
  console.log(`[clinics] Enqueued ${picked.length}. Each is re-qualified, validated and sent within the daily limit.`);
}

main()
  .catch(error => { console.error(`[clinics] FATAL: ${error.message}`); process.exitCode = 1; })
  .finally(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await closeDb().catch(() => {});
  });


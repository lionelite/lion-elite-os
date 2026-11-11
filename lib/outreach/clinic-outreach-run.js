'use strict';

/**
 * One daily clinic outreach run, in-process, with no Redis and no workers.
 *
 * Built for the free Render web service: POST /api/cron/clinic-outreach
 * (routes/clinic-outreach-cron.js), called by .github/workflows/daily-clinic-outreach.yml.
 * The BullMQ pipeline (workers/outreach-worker.js) is untouched and still works
 * wherever Redis exists; this path reuses its pieces rather than replacing them:
 *
 *   (a) discovery      lib/discovery/discovery-run.js (OpenStreetMap + the
 *                      clinic's own site, both free), deduped by domain/e-mail
 *   (b) qualification  lib/outreach/clinic-qualification.js (first touch) and
 *                      lib/outreach/followup-qualification.js (follow-up), then
 *                      the unchanged 16-check engine (lib/outreach-validation.js)
 *   (c) first-touch sends   ┐ PostgresProspectStore.enqueue/markQueue, so the
 *   (d) follow-up sends     ┘ DAILY_EMAIL_LIMIT quota, suppression re-check and
 *                             audit events apply to every send
 *   (e) outreach_runs row, then the Google Sheet mirror
 *
 * Every dependency is injectable so the whole run is testable offline.
 *
 * Idempotency, in three layers:
 *   - one completed non-dry run per New York calendar day (outreach_runs);
 *   - a Postgres advisory lock, so two triggers cannot run concurrently;
 *   - outreach_queue.idempotency_key = sha256(prospect | campaign | step), so a
 *     given prospect can receive a given step once, ever, whatever re-runs.
 *     Resend also receives that key as its Idempotency-Key.
 */

const crypto = require('crypto');
const dns = require('dns');
const { validateProspect, authorizeOutreach, normalizeDomain } = require('../outreach-validation');
const { qualifyClinicProspect, FREE_MAIL } = require('./clinic-qualification');
const { qualifyFollowUp, recordStopFlags } = require('./followup-qualification');
const { isClinicSupply } = require('./draft-router');
const { FOLLOWUP_STEP_ID } = require('./clinic-followup-email');
const { neverEmailReason } = require('./never-email');
const { clinicRelevance } = require('../contacts/clinic-targeting');
const { effectiveDailyCap, newYorkClock, isNewYorkWeekday, sendGapMs } = require('./send-cap');
const control = require('./outreach-control');

const FIRST_TOUCH_CAMPAIGNS = Object.freeze(['osm-business-discovery', 'med_spa_research_supply']);
const SEND_CAMPAIGN = 'med_spa_research_supply';
const CONTACTED_LIKE_STAGES = Object.freeze(['contacted', 'replied', 'sent', 'queued', 'engaged', 'meeting_booked', 'opportunity', 'customer', 'suppressed']);
const REPLY_EVENT_TYPES = Object.freeze(['prospect.replied', 'outreach.replied', 'reply.received', 'inbound.reply']);
const OPT_OUT_EVENT_TYPES = Object.freeze(['prospect.opted_out', 'outreach.opt_out', 'outreach.unsubscribed']);
const REPLIED_STAGES = Object.freeze(['replied', 'engaged', 'meeting_booked', 'opportunity', 'customer']);

const emailOf = p => String(p?.contact?.email || '').trim().toLowerCase();
const domainOfEmail = e => (String(e).includes('@') ? String(e).split('@').pop().toLowerCase() : '');

function stepKey(prospectId, campaignId, step) {
  return crypto.createHash('sha256').update(['clinic-outreach', prospectId, campaignId, step].join('|')).digest('hex');
}

function mapProspect(row) {
  return {
    prospectId: row.prospect_id, fingerprint: row.fingerprint, business: row.business || {}, contact: row.contact || {},
    campaignId: row.campaign_id, ownerId: row.owner_id, stage: row.stage, status: row.status, score: row.score,
    enrichment: row.enrichment || {}, personalization: row.personalization, validation: row.validation,
    nextAction: row.next_action, nextActionAt: row.next_action_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function deliveryConfigured(env) {
  return String(env.OUTREACH_SEND_ENABLED).toLowerCase() === 'true'
    && Boolean(env.RESEND_API_KEY && env.OUTREACH_FROM_EMAIL && env.OUTREACH_POSTAL_ADDRESS);
}

async function lookupMx(domain, { timeoutMs = 5000 } = {}) {
  if (!domain) return { ok: false, detail: 'no domain' };
  try {
    const records = await Promise.race([
      dns.promises.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
    ]);
    return records && records.length
      ? { ok: true, checkedAt: new Date().toISOString(), detail: `${records.length} MX record(s)` }
      : { ok: false, detail: 'no MX records' };
  } catch (error) {
    return { ok: false, detail: `MX lookup failed (${error.code || error.message})` };
  }
}

function bump(map, key, n = 1) { map[key] = (map[key] || 0) + n; }

function createClinicOutreachRunner(deps = {}) {
  const env = deps.env || process.env;
  const database = deps.database || require('../database');
  const db = { query: (...a) => database.query(...a) };
  const pool = deps.pool || database.pool;
  const store = deps.store || new (require('../postgres-prospect-store').PostgresProspectStore)();
  const now = deps.now || (() => new Date());
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = deps.random || Math.random;
  const sendEmail = deps.sendEmail || require('../email-delivery').sendEmail;
  const mxCheck = deps.mxCheck || lookupMx;
  const mirror = deps.mirror || ((prospects) => require('./sheets-mirror').mirrorProspects(prospects, { env }));
  const logger = deps.logger || console;
  const budgetMs = deps.budgetMs ?? Number(env.OUTREACH_RUN_BUDGET_MINUTES || 100) * 60_000;
  const redisHalted = deps.redisHalted !== undefined ? deps.redisHalted
    : (env.REDIS_URL ? () => require('../kill-switch').isHalted() : undefined);

  // ---------------------------------------------------------------- discovery
  async function knownContacts() {
    const result = await db.query(`SELECT lower(contact->>'email') AS email, business->>'website' AS website, business->>'domain' AS domain FROM prospects`);
    const emails = new Set();
    const domains = new Set();
    for (const r of result.rows) {
      if (r.email) { emails.add(r.email); const d = domainOfEmail(r.email); if (d && !FREE_MAIL.includes(d)) domains.add(d); }
      for (const site of [r.website, r.domain]) { const d = normalizeDomain(site || ''); if (d) domains.add(d); }
    }
    return { emails, domains };
  }

  async function defaultDiscover() {
    const { runDiscovery, DEFAULT_AREAS } = require('../discovery/discovery-run');
    const { enrichBusinessEmail } = require('../email-enrichment');
    const rotation = Number(await control.getSetting(db, control.ROTATION_KEY, 0)) || 0;
    const known = await knownContacts();
    const refused = { excluded: 0, knownDomain: 0, knownEmail: 0 };
    const summary = await runDiscovery({
      rotation,
      categories: ['med-spa', 'clinic'],
      batchSize: Number(env.DISCOVERY_BATCH_SIZE || 25),
      enrichEmail: deps.enrichEmail || (business => enrichBusinessEmail(business)),
      fetchImpl: deps.discoveryFetch,
      enrichDelayMs: deps.enrichDelayMs ?? 1500,
      skipBusiness: business => {
        const d = normalizeDomain(business.website || '');
        if (d && known.domains.has(d)) { refused.knownDomain += 1; return true; }
        // Only peptide/HRT/weight-loss/longevity/regenerative/aesthetic practices
        // are worth a record; exclusions never enter the pipeline.
        const tier = clinicRelevance({ name: business.name, website: business.website, category: business.category }).tier;
        if (tier === 'exclude' || tier === 'low') { refused.excluded += 1; return true; }
        return false;
      },
      saveProspect: async input => {
        const email = String(input.contact.email || '').toLowerCase();
        if (email && (known.emails.has(email) || (!FREE_MAIL.includes(domainOfEmail(email)) && known.domains.has(domainOfEmail(email))))) {
          refused.knownEmail += 1;
          return { duplicate: true };
        }
        const created = await store.create(input, 'clinic-outreach-run');
        if (!created.duplicate) {
          await store.update(created.prospect.prospectId, {
            enrichment: {
              source: { type: 'public_directory', provider: 'openstreetmap-overpass', ref: input.business.sourceRef || null, emailFrom: email ? 'business website contact page' : null },
              discoveredBy: 'clinic-outreach-run',
              verifiedAt: email ? new Date(now()).toISOString() : null,
            },
          }, 'clinic-outreach-run');
          if (email) { known.emails.add(email); if (!FREE_MAIL.includes(domainOfEmail(email))) known.domains.add(domainOfEmail(email)); }
        }
        const d = normalizeDomain(input.business.website || '');
        if (d) known.domains.add(d);
        return created;
      },
      logger,
    });
    await control.setSetting(db, control.ROTATION_KEY, rotation + 1, 'clinic-outreach-run');
    return {
      source: 'openstreetmap-overpass (free) + public business website contact pages (free); no paid API used',
      area: summary.area, found: summary.found, stored: summary.stored, duplicates: summary.duplicates + refused.knownEmail,
      skippedKnownDomain: refused.knownDomain, skippedNotTargeted: refused.excluded, emailsFound: summary.enriched,
      unreachableCategories: summary.unreachableCategories, errors: summary.errors.slice(0, 10), nextArea: DEFAULT_AREAS[(rotation + 1) % DEFAULT_AREAS.length].label,
    };
  }
  const discover = deps.discover || defaultDiscover;

  // ------------------------------------------------------------ fact queries
  async function domainContactedElsewhere(prospect) {
    const domain = domainOfEmail(emailOf(prospect));
    if (!domain) return 0;
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM prospects WHERE prospect_id <> $1 AND stage = ANY($3)
       AND lower(split_part(contact->>'email','@',2)) = $2`,
      [prospect.prospectId, domain, CONTACTED_LIKE_STAGES]
    );
    return r.rows[0].n;
  }

  async function followUpFacts(prospect) {
    const email = emailOf(prospect);
    const domain = domainOfEmail(email);
    const base = await store.contactFacts(prospect);
    const key = stepKey(prospect.prospectId, SEND_CAMPAIGN, FOLLOWUP_STEP_ID);
    const [prior, recent, elsewhere] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS n FROM outreach_queue WHERE idempotency_key = $1 AND status IN ('sent','processing')`, [key]),
      db.query(`SELECT COUNT(*)::int AS n, MAX(updated_at) AS last FROM outreach_queue WHERE prospect_id = $1 AND status = 'sent' AND updated_at > now() - interval '30 days'`, [prospect.prospectId]),
      domain ? db.query(
        `SELECT COUNT(DISTINCT q.prospect_id)::int AS n FROM outreach_queue q
         WHERE q.prospect_id <> $1 AND lower(split_part(q.recipient,'@',2)) = $2 AND q.status IN ('sent','processing')
           AND q.message_version LIKE 'clinic-supply-followup-%'`, [prospect.prospectId, domain]) : { rows: [{ n: 0 }] },
    ]);
    return {
      suppression: base.suppression,
      priorFollowUps: prior.rows[0].n,
      recentQueueSends: recent.rows[0].n,
      lastQueueSentAt: recent.rows[0].last || null,
      domainFollowedUpElsewhere: elsewhere.rows[0].n,
    };
  }

  /** Re-read state immediately before a send. @returns {null|{stop, reason}} */
  async function replyOrOptOut(prospectId) {
    const prospect = await store.get(prospectId);
    if (!prospect) return { stop: 'missing', reason: 'prospect no longer exists' };
    const email = emailOf(prospect);
    const never = neverEmailReason(email, env);
    if (never) return { stop: 'never', reason: never };
    if (REPLIED_STAGES.includes(prospect.stage)) return { stop: 'replied', reason: `stage ${prospect.stage}` };
    if (prospect.stage === 'suppressed' || ['suppressed', 'held'].includes(prospect.status)) return { stop: 'suppressed', reason: `stage ${prospect.stage} / status ${prospect.status}` };
    const flags = recordStopFlags({ ...prospect, stage: 'contacted', status: 'active' });
    if (flags.length) return { stop: 'suppressed', reason: flags.join(', ') };
    const facts = await store.contactFacts(prospect);
    if (facts.suppression) return { stop: 'suppressed', reason: `opt-out list (${facts.suppression.reason})` };
    const events = await db.query(
      `SELECT type FROM prospect_events WHERE type = ANY($2) AND (prospect_id = $1 OR prospect_id IN (
         SELECT prospect_id FROM prospects WHERE lower(contact->>'email') = $3)) LIMIT 1`,
      [prospectId, [...REPLY_EVENT_TYPES, ...OPT_OUT_EVENT_TYPES], email]
    );
    if (events.rowCount) {
      return OPT_OUT_EVENT_TYPES.includes(events.rows[0].type)
        ? { stop: 'suppressed', reason: `recorded ${events.rows[0].type}` }
        : { stop: 'replied', reason: `recorded ${events.rows[0].type}` };
    }
    const replied = await db.query(`SELECT 1 FROM outreach_queue WHERE prospect_id = $1 AND status = 'replied' LIMIT 1`, [prospectId]);
    if (replied.rowCount) return { stop: 'replied', reason: 'queue item marked replied' };
    return null;
  }

  async function markStopped(prospectId, found) {
    if (found.stop === 'replied') await store.transition(prospectId, 'replied', { by: 'reply-stop', reason: found.reason }, 'clinic-outreach-run');
    else if (found.stop === 'suppressed') await store.transition(prospectId, 'suppressed', { by: 'reply-stop', reason: found.reason }, 'clinic-outreach-run');
  }

  // ------------------------------------------------------------------- send
  async function sendOne(item) {
    const { prospect, qualification, step } = item;
    const authorization = authorizeOutreach(qualification.view, qualification.policy);
    authorization.idempotencyKey = stepKey(prospect.prospectId, SEND_CAMPAIGN, step);
    const draft = qualification.draft;
    let queued;
    try {
      queued = await store.enqueue(prospect.prospectId, authorization, {
        channel: 'email', recipient: draft.recipient, subject: draft.subject, body: draft.body, messageVersion: draft.messageVersion,
      }, new Date(now()).toISOString(), 'clinic-outreach-run');
    } catch (error) {
      if (error.code === 'PROSPECT_SUPPRESSED') return { outcome: 'skipped', reason: 'suppressed at enqueue' };
      throw error;
    }
    if (queued.duplicate) {
      const s = queued.item.status;
      if (s === 'sent') return { outcome: 'skipped', reason: 'step already sent (idempotency key)' };
      if (s === 'processing') return { outcome: 'skipped', reason: 'step left in processing by an interrupted run; needs a person to check Resend before retrying' };
      if (!(s === 'failed' || s === 'pending') || queued.item.attempts >= 3) return { outcome: 'skipped', reason: `step already ${s}` };
    }
    const queueId = queued.item.queueId;
    try {
      await store.markQueue(queueId, 'processing', {}, 'clinic-outreach-run');
    } catch (error) {
      if (error.code === 'DAILY_EMAIL_QUOTA_REACHED') {
        await db.query('UPDATE prospects SET stage = $2, updated_at = now() WHERE prospect_id = $1', [prospect.prospectId, prospect.stage]);
        return { outcome: 'quota' };
      }
      throw error;
    }
    try {
      const delivery = await sendEmail({ prospect: qualification.view, draft, authorization });
      await store.markQueue(queueId, 'sent', { providerMessageId: delivery.providerId }, 'clinic-outreach-run');
      // The live table records an e-mailed clinic as `contacted`; keep that vocabulary.
      await store.update(prospect.prospectId, {
        stage: 'contacted',
        enrichment: { ...(prospect.enrichment || {}), last_sent: new Date(now()).toISOString().slice(0, 10), lastAutomatedStep: { step, messageVersion: draft.messageVersion, at: new Date(now()).toISOString() } },
      }, 'clinic-outreach-run');
      return { outcome: 'sent', providerId: delivery.providerId };
    } catch (error) {
      await store.markQueue(queueId, 'failed', { lastError: `${error.code || 'DELIVERY_FAILED'}: ${error.message}` }, 'clinic-outreach-run').catch(() => {});
      await db.query('UPDATE prospects SET stage = $2, updated_at = now() WHERE prospect_id = $1', [prospect.prospectId, prospect.stage]).catch(() => {});
      return { outcome: 'failed', reason: `${error.code || 'DELIVERY_FAILED'}: ${error.message}` };
    }
  }

  // -------------------------------------------------------------- the run
  async function selectRows(sql, params) {
    return (await db.query(sql, params)).rows.map(mapProspect);
  }

  async function body({ dryRun, trigger, startedAt }) {
    const clock = newYorkClock(startedAt);
    const summary = {
      runDate: clock.date, trigger, dryRun, examined: 0, discovered: 0, qualified: 0, sent: 0, failed: 0, skipped: 0,
      skipReasons: {}, cap: null, discovery: null, firstTouch: { candidates: 0, qualified: 0, picked: 0 },
      followUp: { candidates: 0, qualified: 0, picked: 0 }, wouldSend: [], sends: [], stopped: [], mirror: null, notes: [],
    };

    const pause = await control.pauseState(db, { redisHalted });
    if (pause.paused) {
      const pausedRun = await control.startRun(db, { runDate: clock.date, trigger, dryRun });
      const result = { ...summary, runId: pausedRun, status: 'paused', skipped: 'paused', pause };
      await control.finishRun(db, pausedRun, { ...result, skipped: 0 }, 'paused');
      return result;
    }
    if (!dryRun && !isNewYorkWeekday(startedAt)) return { ...summary, status: 'skipped', reason: 'weekend (New York time); sends run weekdays only' };
    if (!dryRun) {
      const previous = await control.completedRunToday(db, clock.date);
      if (previous) return { ...summary, status: 'skipped', reason: 'already completed a run today', previousRunId: previous.run_id };
    }

    const runId = await control.startRun(db, { runDate: clock.date, trigger, dryRun });
    summary.runId = runId;
    const elapsed = () => new Date(now()).getTime() - startedAt.getTime();

    try {
      // (a) discovery
      try {
        summary.discovery = await discover();
        summary.discovered = Number(summary.discovery.stored || 0);
      } catch (error) {
        summary.discovery = { error: error.message };
        summary.notes.push(`discovery failed: ${error.message}`);
      }

      // Cap
      const ramp = effectiveDailyCap({ now: startedAt, env });
      const quota = await store.getDailyEmailQuota();
      const cap = Math.min(ramp.cap, quota.remaining);
      summary.cap = { effective: cap, ramp, dailyEmailLimit: quota.limit, sentToday: quota.sent };

      // (b) qualification, first touch
      const firstTouch = await selectRows(
        `SELECT * FROM prospects WHERE stage IN ('discovered','qualified') AND campaign_id = ANY($1)
         AND coalesce(contact->>'email','') <> '' ORDER BY created_at DESC`, [FIRST_TOUCH_CAMPAIGNS]);
      const picks = [];
      const domainsToday = new Set();
      summary.examined += firstTouch.length;
      for (const prospect of firstTouch) {
        const context = { campaignId: prospect.campaignId, category: prospect.business.niche || prospect.business.category };
        if (!isClinicSupply(context)) { bump(summary.skipReasons, 'first touch: not a clinic'); continue; }
        summary.firstTouch.candidates += 1;
        const never = neverEmailReason(emailOf(prospect), env);
        if (never) { bump(summary.skipReasons, 'never-email list'); continue; }
        const facts = await store.contactFacts(prospect);
        facts.domainContactedElsewhere = Number(facts.domainContactedElsewhere || 0) + await domainContactedElsewhere(prospect);
        const q = qualifyClinicProspect(prospect, facts, { now: startedAt, env });
        const validation = q.qualified ? validateProspect(q.view, q.policy) : null;
        await store.update(prospect.prospectId, { validation: { ...(prospect.validation || {}), qualification: {
          qualified: q.qualified && validation.passed, tier: q.tier, evaluatedAt: new Date(now()).toISOString(), checks: q.checks,
          messageVersion: q.draft ? q.draft.messageVersion : null, failedChecks: validation ? validation.failedChecks : null } } }, 'clinic-outreach-run');
        if (!q.qualified || !validation.passed) {
          for (const b of q.blockers) bump(summary.skipReasons, `first touch: ${b.split(':')[0]}`);
          if (validation && !validation.passed) bump(summary.skipReasons, `first touch: 16-check (${validation.failedChecks.join(',')})`);
          continue;
        }
        summary.firstTouch.qualified += 1;
        if (prospect.stage === 'discovered') await store.transition(prospect.prospectId, 'qualified', { by: 'clinic-outreach-run' }, 'clinic-outreach-run');
        const domain = domainOfEmail(emailOf(prospect));
        if (domainsToday.has(domain)) { bump(summary.skipReasons, 'first touch: same organisation already picked'); continue; }
        domainsToday.add(domain);
        picks.push({ prospect, qualification: q, step: 'step1', kind: 'first_touch' });
      }

      // (b) qualification, follow-up
      const contacted = await selectRows(`SELECT * FROM prospects WHERE stage = 'contacted' ORDER BY (enrichment->>'last_sent') ASC NULLS FIRST, created_at ASC`, []);
      const mxCache = new Map();
      const followPicks = [];
      summary.examined += contacted.length;
      for (const prospect of contacted) {
        summary.followUp.candidates += 1;
        const email = emailOf(prospect);
        if (!email) { bump(summary.skipReasons, 'follow-up: no e-mail'); continue; }
        if (neverEmailReason(email, env)) { bump(summary.skipReasons, 'never-email list'); continue; }
        const flags = recordStopFlags(prospect);
        if (flags.length) { bump(summary.skipReasons, `follow-up: ${flags[0]}`); continue; }
        const domain = domainOfEmail(email);
        if (domainsToday.has(domain)) { bump(summary.skipReasons, 'follow-up: same organisation already picked'); continue; }
        const facts = await followUpFacts(prospect);
        if (facts.lastQueueSentAt) prospect.enrichment = { ...prospect.enrichment, last_sent: new Date(Math.max(new Date(facts.lastQueueSentAt).getTime(), new Date(prospect.enrichment.last_sent || 0).getTime())).toISOString() };
        if (!mxCache.has(domain)) mxCache.set(domain, await mxCheck(domain));
        facts.mx = mxCache.get(domain);
        const q = qualifyFollowUp(prospect, facts, { now: startedAt, env });
        const validation = q.qualified ? validateProspect(q.view, q.policy) : null;
        if (!q.qualified || !validation.passed) {
          for (const b of q.blockers) bump(summary.skipReasons, `follow-up: ${b.split(':')[0]}`);
          if (validation && !validation.passed) bump(summary.skipReasons, `follow-up: 16-check (${validation.failedChecks.join(',')})`);
          continue;
        }
        summary.followUp.qualified += 1;
        domainsToday.add(domain);
        followPicks.push({ prospect, qualification: q, step: FOLLOWUP_STEP_ID, kind: 'follow_up' });
      }
      summary.qualified = summary.firstTouch.qualified + summary.followUp.qualified;

      // (c)+(d) one shared cap: first touches first, then follow-ups (spec order)
      const queue = [...picks, ...followPicks].slice(0, cap);
      summary.firstTouch.picked = queue.filter(i => i.kind === 'first_touch').length;
      summary.followUp.picked = queue.filter(i => i.kind === 'follow_up').length;
      const overCap = picks.length + followPicks.length - queue.length;
      if (overCap > 0) bump(summary.skipReasons, 'over today\'s cap (eligible next run)', overCap);
      if (cap === 0) summary.notes.push(`cap is 0: ${ramp.cap === 0 ? ramp.reason : 'DAILY_EMAIL_LIMIT reached'}`);

      if (dryRun) {
        summary.wouldSend = queue.map(i => ({ kind: i.kind, prospectId: i.prospect.prospectId, business: i.prospect.business.displayName || i.prospect.business.name, email: emailOf(i.prospect), subject: i.qualification.draft.subject, messageVersion: i.qualification.draft.messageVersion }));
        if (!deliveryConfigured(env)) summary.notes.push('Sending is not configured (OUTREACH_SEND_ENABLED/RESEND_API_KEY/OUTREACH_FROM_EMAIL/OUTREACH_POSTAL_ADDRESS), so this ran as a dry run. Nothing was queued or sent.');
      } else {
        for (let i = 0; i < queue.length; i += 1) {
          const item = queue[i];
          if (i > 0) {
            const gap = sendGapMs(random);
            if (elapsed() + gap > budgetMs) {
              bump(summary.skipReasons, 'run time budget reached (eligible next run)', queue.length - i);
              break;
            }
            await sleep(gap);
          }
          if ((await control.pauseState(db, { redisHalted })).paused) {
            bump(summary.skipReasons, 'paused mid-run', queue.length - i);
            break;
          }
          const found = await replyOrOptOut(item.prospect.prospectId);
          if (found) {
            await markStopped(item.prospect.prospectId, found);
            summary.stopped.push({ prospectId: item.prospect.prospectId, stop: found.stop, reason: found.reason });
            bump(summary.skipReasons, `stopped before send: ${found.stop}`);
            continue;
          }
          const result = await sendOne(item);
          if (result.outcome === 'quota') {
            bump(summary.skipReasons, 'DAILY_EMAIL_LIMIT reached', queue.length - i);
            break;
          }
          summary.sends.push({ kind: item.kind, prospectId: item.prospect.prospectId, outcome: result.outcome, reason: result.reason || null });
          if (result.outcome === 'sent') summary.sent += 1;
          else if (result.outcome === 'failed') summary.failed += 1;
          else bump(summary.skipReasons, result.reason);
        }
      }

      // Every prospect examined this run that did not end in a send attempt.
      summary.skipped = summary.examined - summary.sent - summary.failed;
      summary.status = 'completed';
      summary.durationMs = elapsed();
      await control.finishRun(db, runId, summary, 'completed');
    } catch (error) {
      summary.status = 'error';
      summary.error = error.message;
      await control.finishRun(db, runId, summary, 'error').catch(() => {});
      logger.error?.(`[clinic-outreach] run failed: ${error.message}`);
    }

    // (e) mirror: everything created or changed during this run.
    try {
      const changed = await db.query(
        `SELECT p.*, q.message_version AS last_step, q.status AS last_queue_status FROM prospects p
         LEFT JOIN LATERAL (SELECT message_version, status FROM outreach_queue WHERE prospect_id = p.prospect_id ORDER BY updated_at DESC LIMIT 1) q ON true
         WHERE p.updated_at >= $1 ORDER BY p.updated_at ASC`, [startedAt]);
      const rows = changed.rows.map(r => ({ ...mapProspect(r), lastStep: r.last_step, lastQueueStatus: r.last_queue_status }));
      summary.mirror = await mirror(rows);
    } catch (error) {
      summary.mirror = { status: 'failed', reason: error.message };
    }
    if (summary.runId) await db.query('UPDATE outreach_runs SET summary = $2::jsonb WHERE run_id = $1', [summary.runId, JSON.stringify(summary)]).catch(() => {});
    return summary;
  }

  async function run({ dryRun = false, trigger = 'http' } = {}) {
    if (!pool) return { status: 'error', error: 'DATABASE_URL is not set' };
    await control.ensureSchema(db);
    const forcedDry = !dryRun && !deliveryConfigured(env);
    const startedAt = new Date(now());
    const locked = await control.withRunLock(pool, () => body({ dryRun: dryRun || forcedDry, trigger, startedAt }));
    if (!locked.locked) return { status: 'skipped', reason: 'another outreach run is in progress' };
    return locked.result;
  }

  /** Record an inbound reply or opt-out for an address (POST /api/cron/outreach-reply). */
  async function recordInbound({ email, type, note = '' }) {
    const address = String(email || '').trim().toLowerCase();
    if (!address.includes('@')) throw Object.assign(new Error('a valid email is required'), { code: 'INVALID_EMAIL' });
    if (!['reply', 'opt_out'].includes(type)) throw Object.assign(new Error('type must be reply or opt_out'), { code: 'INVALID_TYPE' });
    await control.ensureSchema(db);
    if (type === 'opt_out') {
      await store.suppress({ address, reason: 'opt_out', source: 'inbound', note }, 'outreach-reply-endpoint');
    }
    const rows = await db.query(`SELECT prospect_id FROM prospects WHERE lower(contact->>'email') = $1`, [address]);
    for (const r of rows.rows) {
      if (type === 'reply') await store.transition(r.prospect_id, 'replied', { by: 'outreach-reply-endpoint', note }, 'outreach-reply-endpoint');
      await db.query(`INSERT INTO prospect_events (prospect_id, type, actor, data) VALUES ($1,$2,'outreach-reply-endpoint',$3::jsonb)`,
        [r.prospect_id, type === 'reply' ? 'prospect.replied' : 'prospect.opted_out', JSON.stringify({ note })]);
    }
    return { email: address, type, prospectsUpdated: rows.rowCount };
  }

  return { run, recordInbound, stepKey, replyOrOptOut, knownContacts };
}

module.exports = { createClinicOutreachRunner, stepKey, lookupMx, deliveryConfigured, FIRST_TOUCH_CAMPAIGNS, SEND_CAMPAIGN };

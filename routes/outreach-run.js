'use strict';

/**
 * Owner-facing clinic outreach endpoints.
 *
 *   POST /run/clinic-outreach   run one batch now (discovery → qualification → sends)
 *        auth: header `x-outreach-secret: <OUTREACH_SECRET>` (constant-time compare),
 *              or a GitHub Actions OIDC token from an allowed workflow on main
 *              (lib/outreach/github-oidc.js), so the scheduled workflow keeps
 *              working while the secret is being set up.
 *        body/query: dryRun=1 sends nothing; {"test": true} sends ONE sample e-mail
 *              to the owner address configured on the server and returns its
 *              provider message id.
 *        With OUTREACH_SECRET unset the secret path is unavailable (never open).
 *
 *   POST /run/clinic-outreach/plan    the next metros to search + the OSM User-Agent
 *   POST /run/clinic-outreach/areas   upload map answers for those metros into
 *        today's discovery cache (same auth). Used by clinic-outreach.yml, whose
 *        runner can reach Overpass when Render's shared IPs cannot.
 *
 *   GET  /health/outreach       public, no PII: last run time/status, sends today,
 *                               today's cap, last error.
 *
 * The batch can take a long time (sends are spaced 30–90 s apart), so the
 * response is committed as 200 at once and a space is written every 20 s to
 * keep proxies from dropping the idle connection; the JSON summary follows.
 * Callers read `status` from the body: completed | paused | skipped | error.
 * Same streaming contract as routes/clinic-outreach-cron.js.
 */

const crypto = require('crypto');
const express = require('express');
const { createClinicOutreachRunner } = require('../lib/outreach/clinic-outreach-run');
const control = require('../lib/outreach/outreach-control');
const { effectiveDailyCap, windowState } = require('../lib/outreach/send-cap');
const { createGithubOidcVerifier } = require('../lib/outreach/github-oidc');
const { secretMatches } = require('./clinic-outreach-cron');
const { createClinicDiscoveryStore } = require('../lib/discovery/clinic-discovery-store');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const redact = text => String(text || '').replace(EMAIL_RE, '<email>').slice(0, 500);
const truthy = v => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

function createOutreachRunRouter({ runner, discoveryStore, env = process.env, database, heartbeatMs = 20_000, oidcVerifier, logger = console } = {}) {
  const router = express.Router();
  let activeDiscovery = discoveryStore || null;
  const getDiscovery = () => (activeDiscovery ||= createClinicDiscoveryStore({ env }));
  let activeRunner = runner || null;
  const getRunner = () => (activeRunner ||= createClinicOutreachRunner({ env }));
  const getDb = () => database || require('../lib/database');
  const oidc = oidcVerifier || createGithubOidcVerifier({ env });

  // The Supabase pg_cron scheduler authenticates with a secret that was generated
  // inside the database and kept in Supabase Vault. Only its SHA-256 is stored in
  // app_settings (scheduler_secret_sha256), so the secret itself never appears in
  // code, Render configuration, logs or a deploy.
  let schedulerHash = { value: null, at: 0 };
  async function schedulerSecretMatches(given) {
    if (!given) return false;
    if (Date.now() - schedulerHash.at > 60_000) {
      try {
        const r = await getDb().query(`SELECT value #>> '{}' AS v FROM app_settings WHERE key = 'scheduler_secret_sha256'`);
        schedulerHash = { value: r.rows[0]?.v || null, at: Date.now() };
      } catch {
        schedulerHash = { value: null, at: Date.now() };
      }
    }
    if (!schedulerHash.value || !/^[0-9a-f]{64}$/.test(schedulerHash.value)) return false;
    const a = Buffer.from(crypto.createHash('sha256').update(String(given)).digest('hex'));
    const b = Buffer.from(schedulerHash.value);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function authorize(req, res, next) {
    if (env.OUTREACH_SECRET && secretMatches(req.get('x-outreach-secret'), env.OUTREACH_SECRET)) {
      req.caller = { kind: 'outreach-secret' };
      return next();
    }
    if (await schedulerSecretMatches(req.get('x-outreach-secret'))) {
      req.caller = { kind: 'scheduler' };
      return next();
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (bearer) {
      try {
        req.caller = { kind: 'github-oidc', ...(await oidc.verify(bearer[1].trim())) };
        return next();
      } catch (error) {
        logger.warn?.(`[clinic-outreach] /run rejected: OIDC ${error.code || 'OIDC_INVALID'}`);
        return res.status(401).json({ error: 'OIDC_REJECTED', code: error.code || 'OIDC_INVALID' });
      }
    }
    logger.warn?.(`[clinic-outreach] /run rejected: ${env.OUTREACH_SECRET ? 'missing or wrong x-outreach-secret' : 'OUTREACH_SECRET is not set on the server'}`);
    return res.status(401).json({ error: 'UNAUTHORIZED', hint: env.OUTREACH_SECRET ? undefined : 'OUTREACH_SECRET is not configured' });
  }

  router.post('/run/clinic-outreach', authorize, async (req, res) => {
    const trigger = (req.caller.kind === 'github-oidc'
      ? `github/${req.caller.workflow}/${req.caller.event}`
      : req.caller.kind === 'scheduler' ? 'supabase/pg_cron'
        : `secret/${String(req.get('x-trigger') || 'http')}`).slice(0, 60);

    if (truthy(req.query.test) || req.body?.test === true) {
      try {
        return res.json(await getRunner().sendTestEmail());
      } catch (error) {
        logger.error?.(`[clinic-outreach] TEST SEND FAILED: ${error.code || 'ERROR'}: ${redact(error.message)}`);
        return res.status(error.code === 'TEST_RECIPIENT_MISSING' ? 400 : 502)
          .json({ status: 'error', code: error.code || 'ERROR', error: redact(error.message) });
      }
    }

    const dryRun = truthy(req.query.dryRun) || req.body?.dryRun === true;
    if (truthy(req.query.async) || req.body?.async === true) {
      // Fire-and-forget for the scheduler: answer at once, run in the background.
      // The run's advisory lock still makes an overlapping trigger skip.
      res.status(202).json({ status: 'accepted', trigger, dryRun });
      getRunner().run({ dryRun, trigger }).catch(error => logger.error?.(`[clinic-outreach] run ERROR: ${error.message}`));
      return undefined;
    }
    req.setTimeout(0);
    res.setTimeout(0);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    const beat = setInterval(() => res.write(' '), heartbeatMs);
    try {
      const summary = await getRunner().run({ dryRun, trigger });
      res.end(JSON.stringify(summary));
    } catch (error) {
      logger.error?.(`[clinic-outreach] run ERROR: ${error.message}`);
      res.end(JSON.stringify({ status: 'error', error: error.message }));
    } finally {
      clearInterval(beat);
    }
  });

  // Discovery prefetch, for a client with working map access (the GitHub runner;
  // Render's shared IPs are refused by Overpass and rate-limited by Nominatim).
  router.post('/run/clinic-outreach/plan', authorize, async (req, res) => {
    try {
      res.json(await getRunner().discoveryPlan({ count: Number(req.body?.count || req.query.count || 6) }));
    } catch (error) {
      res.status(500).json({ status: 'error', error: redact(error.message) });
    }
  });

  router.post('/run/clinic-outreach/areas', authorize, async (req, res) => {
    try {
      res.json(await getRunner().storeAreaResults({ areas: req.body?.areas }));
    } catch (error) {
      res.status(500).json({ status: 'error', error: redact(error.message) });
    }
  });

  // Clinic discovery (scripts/discover-clinics.js on the GitHub runner). The
  // runner does the map search and the website crawl; these endpoints decide
  // what is new and write it, so the runner never holds a database credential.
  const discoveryRoute = (path, handler) => router.post(path, authorize, async (req, res) => {
    try {
      res.json(await handler(req.body || {}, req));
    } catch (error) {
      res.status(error.code === 'UNKNOWN_AREA' ? 400 : 500).json({ status: 'error', code: error.code, error: redact(error.message) });
    }
  });
  discoveryRoute('/run/clinic-discovery/state', () => getDiscovery().state());
  discoveryRoute('/run/clinic-discovery/known', body => getDiscovery().known({ domains: body.domains }));
  discoveryRoute('/run/clinic-discovery/store', body => getDiscovery().storeBatch({
    area: body.area, areaIndex: Number.isInteger(body.areaIndex) ? body.areaIndex : undefined,
    candidates: body.candidates, noEmailDomains: body.noEmailDomains,
  }));
  discoveryRoute('/run/clinic-discovery/log', (body, req) => getDiscovery().logRun({
    trigger: req.caller.kind === 'github-oidc' ? `github/${req.caller.workflow}/${req.caller.event}` : 'secret',
    totals: body.totals, metros: body.metros, startedAt: body.startedAt,
  }));

  // Health with explicit criteria. A running web service is not evidence that
  // sending works, and evidence that cannot be read is `unknown`, never green.
  //   failing  — inside the window and the scheduler has not ticked for 25 min,
  //              or no run has completed for 30 min, or the provider blocked (429)
  //   degraded — uncertain submissions are held, or eligible supply is below
  //              what is left of today's allowance
  //   healthy  — otherwise
  //   unknown  — the scheduler's own record cannot be read
  router.get('/health/outreach', async (_req, res) => {
    const cap = effectiveDailyCap({ env });
    const win = windowState(new Date(), env);
    const safe = q => q.catch(() => null);
    try {
      const db = getDb();
      await control.ensureSchema(db);
      const [last, today, runError, sendError, usage, held, lastLive, tick] = await Promise.all([
        db.query(`SELECT run_id, trigger, dry_run, status, discovered, qualified, sent, failed, started_at, finished_at,
                         summary->>'providerBlocked' AS provider_blocked
                  FROM outreach_runs ORDER BY started_at DESC LIMIT 1`),
        db.query(`SELECT COUNT(*)::int AS n FROM outreach_queue WHERE status = 'sent'
                  AND (updated_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`),
        db.query(`SELECT started_at AS at, coalesce(summary->>'error', summary->'discovery'->>'error', 'run ended with status error') AS message
                  FROM outreach_runs WHERE status = 'error' OR summary->'discovery' ? 'error' ORDER BY started_at DESC LIMIT 1`),
        db.query(`SELECT updated_at AS at, last_error AS message FROM outreach_queue
                  WHERE status IN ('failed','uncertain') AND coalesce(last_error, '') <> '' ORDER BY updated_at DESC LIMIT 1`),
        safe(db.query(`SELECT sent_count FROM daily_usage WHERE channel = 'email' AND usage_day = (now() AT TIME ZONE 'America/New_York')::date`)),
        safe(db.query(`SELECT COUNT(*)::int AS n FROM outreach_queue WHERE status IN ('uncertain','processing')`)),
        safe(db.query(`SELECT finished_at, sent, qualified FROM outreach_runs WHERE status = 'completed' AND dry_run = false ORDER BY started_at DESC LIMIT 1`)),
        safe(db.query(`SELECT d.start_time, d.status, d.return_message FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
                       WHERE j.jobname = 'clinic-outreach-send' ORDER BY d.start_time DESC LIMIT 1`)),
      ]);
      const errors = [runError.rows[0] && { source: 'run', ...runError.rows[0] }, sendError.rows[0] && { source: 'send', ...sendError.rows[0] }]
        .filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at));
      const run = last.rows[0] || null;
      const acceptedToday = usage?.rows?.[0] ? Number(usage.rows[0].sent_count) : null;
      const heldUncertain = held?.rows?.[0] ? held.rows[0].n : null;
      const live = lastLive?.rows?.[0] || null;
      const lastTick = tick?.rows?.[0] || null;
      const minutesSince = t => (t ? (Date.now() - new Date(t).getTime()) / 60000 : Infinity);
      const remaining = acceptedToday === null ? null : Math.max(0, cap.cap - acceptedToday);
      const reasons = [];
      let status = 'healthy';
      if (!tick) { status = 'unknown'; reasons.push('scheduler record (cron.job_run_details) not readable'); }
      else if (!lastTick) { status = 'unknown'; reasons.push('scheduler record: no tick of clinic-outreach-send recorded'); }
      if (win.open) {
        if (tick && minutesSince(lastTick?.start_time) > 25) { status = 'failing'; reasons.push('scheduler has not ticked in 25 minutes during the window'); }
        if (minutesSince(run?.finished_at || run?.started_at) > 30) { status = 'failing'; reasons.push('no outreach run in 30 minutes during the window'); }
      }
      if (run?.provider_blocked) { status = 'failing'; reasons.push(`provider blocked: ${run.provider_blocked}`); }
      if (status === 'healthy' && heldUncertain) { status = 'degraded'; reasons.push(`${heldUncertain} uncertain submission(s) held`); }
      if (status === 'healthy' && remaining && live && Number(live.qualified) < remaining) { status = 'degraded'; reasons.push(`eligible supply (${live.qualified}) below today's remaining allowance (${remaining})`); }
      res.json({
        ok: true,
        status,
        reasons,
        window: { ...win, msLeft: undefined, minutesLeft: Math.round(win.msLeft / 60000) },
        lastRunAt: run ? (run.finished_at || run.started_at) : null,
        lastRun: run,
        lastLiveRun: live,
        sendsToday: today.rows[0].n,
        acceptedToday,
        remainingToday: remaining,
        uncertainHeld: heldUncertain,
        dailySendCap: cap.cap,
        scheduler: lastTick ? { lastTickAt: lastTick.start_time, status: lastTick.status, message: redact(lastTick.return_message) } : null,
        lastError: errors[0] ? { source: errors[0].source, at: errors[0].at, message: redact(errors[0].message) } : null,
      });
    } catch (error) {
      res.status(503).json({ ok: false, status: 'unknown', error: redact(error.message), dailySendCap: cap.cap });
    }
  });

  return router;
}

module.exports = { createOutreachRunRouter };

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
 *   GET  /health/outreach       public, no PII: last run time/status, sends today,
 *                               today's cap, last error.
 *
 * The batch can take a long time (sends are spaced 30–90 s apart), so the
 * response is committed as 200 at once and a space is written every 20 s to
 * keep proxies from dropping the idle connection; the JSON summary follows.
 * Callers read `status` from the body: completed | paused | skipped | error.
 * Same streaming contract as routes/clinic-outreach-cron.js.
 */

const express = require('express');
const { createClinicOutreachRunner } = require('../lib/outreach/clinic-outreach-run');
const control = require('../lib/outreach/outreach-control');
const { effectiveDailyCap } = require('../lib/outreach/send-cap');
const { createGithubOidcVerifier } = require('../lib/outreach/github-oidc');
const { secretMatches } = require('./clinic-outreach-cron');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const redact = text => String(text || '').replace(EMAIL_RE, '<email>').slice(0, 500);
const truthy = v => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

function createOutreachRunRouter({ runner, env = process.env, database, heartbeatMs = 20_000, oidcVerifier, logger = console } = {}) {
  const router = express.Router();
  let activeRunner = runner || null;
  const getRunner = () => (activeRunner ||= createClinicOutreachRunner({ env }));
  const getDb = () => database || require('../lib/database');
  const oidc = oidcVerifier || createGithubOidcVerifier({ env });

  async function authorize(req, res, next) {
    if (env.OUTREACH_SECRET && secretMatches(req.get('x-outreach-secret'), env.OUTREACH_SECRET)) {
      req.caller = { kind: 'outreach-secret' };
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

  router.get('/health/outreach', async (_req, res) => {
    const cap = effectiveDailyCap({ env });
    try {
      const db = getDb();
      await control.ensureSchema(db);
      const [last, today, runError, sendError] = await Promise.all([
        db.query(`SELECT run_id, trigger, dry_run, status, discovered, qualified, sent, failed, started_at, finished_at
                  FROM outreach_runs ORDER BY started_at DESC LIMIT 1`),
        db.query(`SELECT COUNT(*)::int AS n FROM outreach_queue WHERE status = 'sent'
                  AND (updated_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`),
        db.query(`SELECT started_at AS at, coalesce(summary->>'error', summary->'discovery'->>'error', 'run ended with status error') AS message
                  FROM outreach_runs WHERE status = 'error' OR summary->'discovery' ? 'error' ORDER BY started_at DESC LIMIT 1`),
        db.query(`SELECT updated_at AS at, last_error AS message FROM outreach_queue
                  WHERE status = 'failed' AND coalesce(last_error, '') <> '' ORDER BY updated_at DESC LIMIT 1`),
      ]);
      const errors = [runError.rows[0] && { source: 'run', ...runError.rows[0] }, sendError.rows[0] && { source: 'send', ...sendError.rows[0] }]
        .filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at));
      const run = last.rows[0] || null;
      res.json({
        ok: true,
        lastRunAt: run ? (run.finished_at || run.started_at) : null,
        lastRun: run,
        sendsToday: today.rows[0].n,
        dailySendCap: cap.cap,
        lastError: errors[0] ? { source: errors[0].source, at: errors[0].at, message: redact(errors[0].message) } : null,
      });
    } catch (error) {
      res.status(503).json({ ok: false, error: redact(error.message), dailySendCap: cap.cap });
    }
  });

  return router;
}

module.exports = { createOutreachRunRouter };

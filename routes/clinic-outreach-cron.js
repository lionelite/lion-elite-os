'use strict';

/**
 * HTTP trigger for the daily clinic outreach run (lib/outreach/clinic-outreach-run.js).
 *
 * Every route requires the header `x-cron-secret` to equal env CRON_SECRET,
 * compared in constant time. With CRON_SECRET unset every route answers 503:
 * an unconfigured secret must never mean an open endpoint.
 *
 *   POST /api/cron/clinic-outreach        run now (?dryRun=1 or {"dryRun":true} to send nothing)
 *   GET  /api/cron/clinic-outreach/status pause state, today's cap, last 10 runs
 *   POST /api/cron/outreach-pause         {"paused": true|false, "reason": "..."}
 *   POST /api/cron/outreach-reply         {"email": "...", "type": "reply"|"opt_out"} — stops the sequence
 *
 * The run can take over an hour (sends are spaced 30–90 s apart). The response
 * is committed as 200 immediately and a space is written every 20 s so no proxy
 * drops an idle connection; the JSON summary follows (leading whitespace is
 * valid JSON). Callers must therefore read `status` in the body, not the HTTP
 * code: completed | paused | skipped | error.
 */

const crypto = require('crypto');
const express = require('express');
const { createClinicOutreachRunner } = require('../lib/outreach/clinic-outreach-run');
const control = require('../lib/outreach/outreach-control');
const { effectiveDailyCap } = require('../lib/outreach/send-cap');

function secretMatches(given, expected) {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function createClinicOutreachCronRouter({ runner, env = process.env, database, heartbeatMs = 20_000 } = {}) {
  const router = express.Router();
  let activeRunner = runner || null;
  const getRunner = () => (activeRunner ||= createClinicOutreachRunner({ env }));
  const getDb = () => database || require('../lib/database');

  router.use((req, res, next) => {
    if (!env.CRON_SECRET) return res.status(503).json({ error: 'CRON_SECRET_NOT_CONFIGURED' });
    if (!secretMatches(req.get('x-cron-secret'), env.CRON_SECRET)) return res.sendStatus(401);
    return next();
  });

  router.post('/clinic-outreach', async (req, res) => {
    const dryRun = ['1', 'true'].includes(String(req.query.dryRun || '').toLowerCase()) || req.body?.dryRun === true;
    req.setTimeout(0);
    res.setTimeout(0);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    const beat = setInterval(() => res.write(' '), heartbeatMs);
    try {
      const summary = await getRunner().run({ dryRun, trigger: String(req.get('x-trigger') || 'http').slice(0, 40) });
      res.end(JSON.stringify(summary));
    } catch (error) {
      res.end(JSON.stringify({ status: 'error', error: error.message }));
    } finally {
      clearInterval(beat);
    }
  });

  router.get('/clinic-outreach/status', async (_req, res) => {
    try {
      const db = getDb();
      await control.ensureSchema(db);
      const [pause, runs] = await Promise.all([
        control.pauseState(db),
        db.query(`SELECT run_id, run_date, trigger, dry_run, status, discovered, qualified, sent, failed, skipped, skip_reasons, started_at, finished_at
                  FROM outreach_runs ORDER BY started_at DESC LIMIT 10`),
      ]);
      res.json({ pause, cap: effectiveDailyCap({ env }), runs: runs.rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/outreach-pause', async (req, res) => {
    if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ error: 'body must be {"paused": true|false}' });
    try {
      const db = getDb();
      await control.ensureSchema(db);
      const state = await control.setPaused(db, req.body.paused, { reason: String(req.body.reason || '').slice(0, 300), by: 'cron-endpoint' });
      res.json(state);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/outreach-reply', async (req, res) => {
    try {
      res.json(await getRunner().recordInbound({ email: req.body?.email, type: req.body?.type, note: String(req.body?.note || '').slice(0, 500) }));
    } catch (error) {
      res.status(['INVALID_EMAIL', 'INVALID_TYPE'].includes(error.code) ? 400 : 500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createClinicOutreachCronRouter, secretMatches };

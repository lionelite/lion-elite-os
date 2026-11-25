'use strict';

/**
 * The daily agent brief (docs/daily-agent-brief.md).
 *
 *   POST /run/agents/daily-brief          read live numbers, build today's brief, store it, return it
 *        ?async=1                         answer 202 at once and build in the background (pg_cron)
 *   GET  /run/agents/daily-brief/latest   the most recent stored brief
 *
 * Auth: identical to /run/clinic-outreach (lib/outreach/run-auth.js): the
 * OUTREACH_SECRET header, the Supabase scheduler secret for job
 * `agent-daily-brief`, or a GitHub OIDC token from an allowlisted workflow.
 *
 * Read-only toward the business: it reads metrics and writes one row to
 * agent_briefs. It sends, publishes and spends nothing.
 */

const express = require('express');
const { createRunAuthorizer, describeCaller } = require('../lib/outreach/run-auth');
const { createGithubOidcVerifier } = require('../lib/outreach/github-oidc');
const { collectMetrics } = require('../lib/agents/brief-metrics');
const { buildBrief } = require('../lib/agents/daily-brief');
const { createBriefStore } = require('../lib/agents/brief-store');
const { effectiveDailyCap } = require('../lib/outreach/send-cap');

const truthy = v => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

function createAgentBriefRouter({ env = process.env, database, oidcVerifier, store, collect, logger = console, now = () => new Date() } = {}) {
  const router = express.Router();
  const getDb = () => database || require('../lib/database');
  const oidc = oidcVerifier || createGithubOidcVerifier({ env });
  const briefs = store || createBriefStore({ getDb });
  const gather = collect || (() => collectMetrics(getDb()));
  const authorize = createRunAuthorizer({ env, getDb, oidc, logger, credentialName: 'agent-daily-brief', label: 'agent-brief' });

  let running = null; // one build at a time per process
  async function generate(trigger) {
    if (running) return running;
    running = (async () => {
      const at = now();
      const metrics = await gather();
      let dailyCap = null;
      try { dailyCap = effectiveDailyCap({ now: at, env }).cap; } catch { dailyCap = null; }
      const brief = buildBrief(metrics, { now: at, dailyCap, trigger });
      try {
        await briefs.save({ brief, metrics });
        brief.stored = true;
      } catch (error) {
        brief.stored = false;
        logger.error?.(`[agent-brief] could not store brief: ${error.code || error.message}`);
      }
      logger.log?.(`[agent-brief] ${brief.date} built (${trigger}): ${brief.ownerActions.length} for owner, ${brief.claudeActions.length} for Claude, ${brief.blockers.length} blocked`);
      return brief;
    })();
    try { return await running; } finally { running = null; }
  }

  router.post('/run/agents/daily-brief', authorize, async (req, res) => {
    const trigger = describeCaller(req);
    if (truthy(req.query.async)) {
      res.status(202).json({ status: 'accepted', trigger });
      generate(trigger).catch(error => logger.error?.(`[agent-brief] build failed: ${error.message}`));
      return undefined;
    }
    try {
      const brief = await generate(trigger);
      return res.json({ status: 'ok', date: brief.date, stored: brief.stored, headline: brief.headline,
        ownerActions: brief.ownerActions, claudeActions: brief.claudeActions, blockers: brief.blockers, markdown: brief.markdown });
    } catch (error) {
      logger.error?.(`[agent-brief] build failed: ${error.message}`);
      return res.status(500).json({ status: 'error', error: 'BRIEF_FAILED' });
    }
  });

  router.get('/run/agents/daily-brief/latest', authorize, async (_req, res) => {
    try {
      const row = await briefs.latest();
      if (!row) return res.status(404).json({ status: 'none' });
      return res.json({ status: 'ok', date: row.date, generatedAt: row.generated_at, trigger: row.trigger, markdown: row.markdown });
    } catch (error) {
      logger.error?.(`[agent-brief] latest failed: ${error.code || error.message}`);
      return res.status(500).json({ status: 'error', error: 'BRIEF_READ_FAILED' });
    }
  });

  return router;
}

module.exports = { createAgentBriefRouter };

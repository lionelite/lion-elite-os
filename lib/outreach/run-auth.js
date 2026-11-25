'use strict';

// Shared authorization for the service's /run/* endpoints. Extracted from
// routes/outreach-run.js unchanged so the daily agent brief can use exactly the
// same three ways in, with no second copy of security code:
//
//   1. header `x-outreach-secret` = OUTREACH_SECRET (constant-time compare)
//   2. header `x-outreach-secret` = a Supabase pg_cron scheduler secret. The
//      secret lives in Supabase Vault; only its SHA-256 is in
//      scheduler_credentials (readable by the service, owned by the DB admin),
//      so it never appears in code, Render config, logs or chat. Each scheduled
//      job has its own credential row, named by `credentialName`.
//   3. `Authorization: Bearer <GitHub Actions OIDC token>` from an allowlisted
//      workflow on main (lib/outreach/github-oidc.js).
//
// No configuration leaves a route open.

const crypto = require('crypto');
const { secretMatches } = require('../../routes/clinic-outreach-cron');

function createRunAuthorizer({
  env = process.env,
  getDb,
  oidc,
  logger = console,
  credentialName,
  legacyAppSettingsKey = null,
  label = 'run',
} = {}) {
  if (!credentialName) throw new Error('createRunAuthorizer: credentialName is required');
  if (legacyAppSettingsKey && !/^[a-z0-9_]+$/.test(legacyAppSettingsKey)) throw new Error('createRunAuthorizer: invalid legacyAppSettingsKey');
  let cached = { value: null, at: 0 };

  async function schedulerSecretMatches(given) {
    if (!given) return false;
    if (Date.now() - cached.at > 60_000) {
      try {
        const db = getDb();
        let r = await db.query('SELECT sha256 AS v FROM scheduler_credentials WHERE name = $1', [credentialName])
          .catch(() => ({ rows: [] }));
        if (!r.rows[0] && legacyAppSettingsKey) {
          // Key is a code constant (validated below), inlined as before.
          r = await db.query(`SELECT value #>> '{}' AS v FROM app_settings WHERE key = '${legacyAppSettingsKey}'`);
        }
        cached = { value: r.rows[0]?.v || null, at: Date.now() };
      } catch {
        cached = { value: null, at: Date.now() };
      }
    }
    if (!cached.value || !/^[0-9a-f]{64}$/.test(cached.value)) return false;
    const a = Buffer.from(crypto.createHash('sha256').update(String(given)).digest('hex'));
    const b = Buffer.from(cached.value);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return async function authorize(req, res, next) {
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
        logger.warn?.(`[${label}] /run rejected: OIDC ${error.code || 'OIDC_INVALID'}`);
        return res.status(401).json({ error: 'OIDC_REJECTED', code: error.code || 'OIDC_INVALID' });
      }
    }
    logger.warn?.(`[${label}] /run rejected: ${env.OUTREACH_SECRET ? 'missing or wrong x-outreach-secret' : 'OUTREACH_SECRET is not set on the server'}`);
    return res.status(401).json({ error: 'UNAUTHORIZED', hint: env.OUTREACH_SECRET ? undefined : 'OUTREACH_SECRET is not configured' });
  };
}

function describeCaller(req) {
  if (req.caller?.kind === 'github-oidc') return `github/${req.caller.workflow}/${req.caller.event}`.slice(0, 60);
  if (req.caller?.kind === 'scheduler') return 'supabase/pg_cron';
  return `secret/${String(req.get('x-trigger') || 'http')}`.slice(0, 60);
}

module.exports = { createRunAuthorizer, describeCaller };

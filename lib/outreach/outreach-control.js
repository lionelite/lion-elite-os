'use strict';

/**
 * Postgres-backed control state for the HTTP-triggered outreach run, which runs
 * on a free Render web service with no Redis:
 *
 *   app_settings  key/value settings. `outreach_paused` is the kill switch for
 *                 this path, replacing the Redis flag (lib/kill-switch.js) that
 *                 cannot be reached here. `discovery_rotation` remembers which
 *                 metro discovery searches next.
 *   outreach_runs one row per run: counts, skip reasons, and the full summary.
 *
 * The pause switch fails CLOSED, exactly like the Redis one: if the setting
 * cannot be read (no database, table missing, query error) the run treats
 * outreach as paused. When REDIS_URL is configured the Redis switch is honoured
 * as well, so pausing either one stops this path.
 */

const PAUSE_KEY = 'outreach_paused';
const ROTATION_KEY = 'discovery_rotation';
const RUN_LOCK_KEY = 727_101; // pg advisory lock: one outreach run at a time

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT 'null'::jsonb,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outreach_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date DATE NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'http',
  dry_run BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'running',
  discovered INTEGER NOT NULL DEFAULT 0,
  qualified INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  skip_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outreach_runs_date_idx ON outreach_runs(run_date, status);
`;

async function ensureSchema(db) {
  await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await db.query(SCHEMA_SQL);
}

async function getSetting(db, key, fallback = null) {
  const result = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return result.rowCount ? result.rows[0].value : fallback;
}

async function setSetting(db, key, value, by = 'system') {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), by]
  );
}

/** @returns {{ paused: boolean, reason?: string, source: string }} */
async function pauseState(db, { redisHalted } = {}) {
  let state;
  try {
    const value = await getSetting(db, PAUSE_KEY, null);
    const paused = value === true || Boolean(value && typeof value === 'object' && value.paused === true);
    state = { paused, source: 'app_settings', ...(paused && value && typeof value === 'object' ? { reason: value.reason, by: value.by, at: value.at } : {}) };
  } catch (error) {
    return { paused: true, source: 'app_settings', reason: `pause setting unreadable (${error.message}); failing closed` };
  }
  if (!state.paused && typeof redisHalted === 'function') {
    if (await redisHalted()) return { paused: true, source: 'redis kill switch', reason: 'Redis kill switch engaged or unreadable' };
  }
  return state;
}

async function setPaused(db, paused, { reason = '', by = 'unknown' } = {}) {
  const value = paused ? { paused: true, reason, by, at: new Date().toISOString() } : { paused: false, by, at: new Date().toISOString() };
  await setSetting(db, PAUSE_KEY, value, by);
  return value;
}

async function completedRunToday(db, runDate) {
  const result = await db.query(
    `SELECT run_id, summary FROM outreach_runs WHERE run_date = $1 AND status = 'completed' AND dry_run = false
     ORDER BY started_at DESC LIMIT 1`,
    [runDate]
  );
  return result.rows[0] || null;
}

async function startRun(db, { runDate, trigger, dryRun }) {
  const result = await db.query(
    'INSERT INTO outreach_runs (run_date, trigger, dry_run) VALUES ($1, $2, $3) RETURNING run_id',
    [runDate, trigger, Boolean(dryRun)]
  );
  return result.rows[0].run_id;
}

async function finishRun(db, runId, summary, status = 'completed') {
  await db.query(
    `UPDATE outreach_runs SET status = $2, discovered = $3, qualified = $4, sent = $5, failed = $6, skipped = $7,
       skip_reasons = $8::jsonb, summary = $9::jsonb, finished_at = now() WHERE run_id = $1`,
    [runId, status, summary.discovered || 0, summary.qualified || 0, summary.sent || 0, summary.failed || 0,
      summary.skipped || 0, JSON.stringify(summary.skipReasons || {}), JSON.stringify(summary)]
  );
}

/**
 * Hold a session-level advisory lock for the duration of `work`. Returns
 * { locked: false } without running `work` when another run holds it.
 */
async function withRunLock(pool, work) {
  const client = await pool.connect();
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [RUN_LOCK_KEY]);
    if (!got.rows[0].ok) return { locked: false };
    try {
      return { locked: true, result: await work() };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [RUN_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

module.exports = {
  PAUSE_KEY, ROTATION_KEY, RUN_LOCK_KEY, SCHEMA_SQL,
  ensureSchema, getSetting, setSetting, pauseState, setPaused,
  completedRunToday, startRun, finishRun, withRunLock,
};

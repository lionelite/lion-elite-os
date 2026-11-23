'use strict';

// One daily agent brief per New York day, kept in Postgres so it survives the
// free instance sleeping. Re-running the same day replaces that day's brief
// (the numbers have moved), and the history of earlier days is kept.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_briefs (
  brief_date DATE PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger TEXT NOT NULL DEFAULT 'manual',
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  brief JSONB NOT NULL DEFAULT '{}'::jsonb,
  markdown TEXT NOT NULL DEFAULT ''
);
`;

function createBriefStore({ getDb }) {
  let ensured = false;
  async function ensure() {
    if (ensured) return;
    await getDb().query(SCHEMA_SQL);
    ensured = true;
  }

  async function save({ brief, metrics }) {
    await ensure();
    const { markdown, ...rest } = brief;
    await getDb().query(
      `INSERT INTO agent_briefs (brief_date, generated_at, trigger, metrics, brief, markdown)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (brief_date) DO UPDATE SET generated_at = EXCLUDED.generated_at, trigger = EXCLUDED.trigger,
         metrics = EXCLUDED.metrics, brief = EXCLUDED.brief, markdown = EXCLUDED.markdown`,
      [brief.date, brief.generatedAt, brief.trigger, JSON.stringify(metrics), JSON.stringify(rest), markdown],
    );
  }

  async function latest() {
    await ensure();
    const r = await getDb().query(
      `SELECT brief_date::text AS date, generated_at, trigger, markdown, brief FROM agent_briefs ORDER BY brief_date DESC LIMIT 1`,
    );
    return r.rows[0] || null;
  }

  return { save, latest, ensure };
}

module.exports = { createBriefStore, SCHEMA_SQL };

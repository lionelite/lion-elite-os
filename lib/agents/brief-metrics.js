'use strict';

// Real numbers for the daily agent brief, read from the production database.
//
// Each metric is its own read-only query. A query that fails (missing table,
// a permission the service role does not have) yields { error } for that metric
// only: the brief then says "no data" for that line instead of inventing a zero,
// and the rest of the brief still runs. Nothing here writes.
//
// Days are New York days, matching daily_usage and the outreach send window.

const TZ = 'America/New_York';
const CLINIC_CAMPAIGNS = Object.freeze(['lion-elite-clinical', 'osm-business-discovery', 'med_spa_research_supply']);

// Exported so a person (or a test) can run exactly what the service runs.
const QUERIES = Object.freeze({
  clinicFunnel: {
    sql: `SELECT stage, count(*)::int AS n FROM prospects WHERE campaign_id = ANY($1) GROUP BY stage`,
    params: () => [CLINIC_CAMPAIGNS],
  },
  clinicReplies: {
    sql: `SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE updated_at > now() - interval '7 days')::int AS last7
            FROM prospects WHERE campaign_id = ANY($1) AND stage = 'replied'`,
    params: () => [CLINIC_CAMPAIGNS],
  },
  sendsByDay: {
    sql: `SELECT usage_day::text AS day, sent_count::int AS sent FROM daily_usage
           WHERE channel = 'email' AND usage_day >= (now() AT TIME ZONE '${TZ}')::date - 7
           ORDER BY usage_day DESC`,
  },
  outreachRuns24h: {
    sql: `SELECT trigger, status, sent, skip_reasons FROM outreach_runs
           WHERE started_at > now() - interval '24 hours' ORDER BY started_at DESC LIMIT 200`,
  },
  schedulerTicks24h: {
    sql: `SELECT job, count(*)::int AS ticks, max(ticked_at) AS last FROM scheduler_heartbeats
           WHERE ticked_at > now() - interval '24 hours' GROUP BY job`,
  },
  discoveryRuns24h: {
    sql: `SELECT count(*)::int AS runs, coalesce(sum(stored), 0)::int AS stored, coalesce(sum(found), 0)::int AS found
            FROM clinic_discovery_runs WHERE started_at > now() - interval '24 hours'`,
  },
  outreachPaused: {
    sql: `SELECT value FROM app_settings WHERE key = 'outreach_paused'`,
  },
  storeOrders: {
    sql: `SELECT
            count(*) FILTER (WHERE (created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date - 1)::int AS y_orders,
            coalesce(sum(total) FILTER (WHERE (created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date - 1), 0)::float AS y_revenue,
            count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS d7_orders,
            coalesce(sum(total) FILTER (WHERE created_at > now() - interval '7 days'), 0)::float AS d7_revenue,
            count(*) FILTER (WHERE created_at > now() - interval '14 days' AND created_at <= now() - interval '7 days')::int AS prev7_orders,
            coalesce(sum(total) FILTER (WHERE created_at > now() - interval '14 days' AND created_at <= now() - interval '7 days'), 0)::float AS prev7_revenue,
            count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS d30_orders,
            coalesce(sum(total) FILTER (WHERE created_at > now() - interval '30 days'), 0)::float AS d30_revenue,
            max(created_at) AS last_order_at
          FROM affiliate_orders WHERE NOT coalesce(is_test, false)`,
  },
  coachingClients: {
    sql: `SELECT status, count(*)::int AS n FROM coaching_clients GROUP BY status`,
  },
  coachingCheckins7d: {
    sql: `SELECT count(*)::int AS n FROM coaching_checkins WHERE created_at > now() - interval '7 days'`,
  },
  capturedLeads: {
    sql: `SELECT coalesce(lane, 'unknown') AS lane, count(*)::int AS total,
                 count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7
            FROM captured_leads GROUP BY 1`,
  },
  funnelLeads: {
    sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7
            FROM gtm_funnel_leads`,
  },
  funnelEvents7d: {
    sql: `SELECT count(*)::int AS n FROM gtm_funnel_events WHERE occurred_at > now() - interval '7 days'`,
  },
});

async function runOne(db, name) {
  const q = QUERIES[name];
  try {
    const r = await db.query(q.sql, q.params ? q.params() : undefined);
    return { rows: r.rows };
  } catch (error) {
    return { error: String(error.code || error.message || 'QUERY_FAILED').slice(0, 120) };
  }
}

/** Run every metric query. Never throws. */
async function collectMetrics(db) {
  const out = {};
  for (const name of Object.keys(QUERIES)) {
    out[name] = await runOne(db, name); // sequential: the free DB pool is small
  }
  return out;
}

module.exports = { QUERIES, CLINIC_CAMPAIGNS, collectMetrics, TZ };

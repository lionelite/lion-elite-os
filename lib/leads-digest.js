'use strict';

// Leads digest: one queryable answer to "what leads are we getting and how
// do they rate". Used by the executive worker (attached to every report)
// and the executive API's GET /leads/digest endpoint.

const { pool } = require('./db');

async function buildLeadsDigest() {
  const [byStage, byCampaign, totals, topLeads, queueByStatus, sentByDay] = await Promise.all([
    pool.query(
      `SELECT stage, COUNT(*)::int AS count, ROUND(AVG(score))::int AS avg_score
       FROM prospects GROUP BY stage ORDER BY count DESC`
    ),
    pool.query(
      `SELECT campaign_id, COUNT(*)::int AS count, ROUND(AVG(score))::int AS avg_score
       FROM prospects WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY campaign_id ORDER BY count DESC LIMIT 20`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS new_today,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_7d,
              COUNT(*) FILTER (WHERE status = 'suppressed')::int AS suppressed
       FROM prospects`
    ),
    pool.query(
      `SELECT business->>'name' AS name, score, stage, campaign_id,
              created_at::date::text AS created
       FROM prospects
       WHERE status <> 'suppressed'
       ORDER BY score DESC NULLS LAST, created_at DESC LIMIT 10`
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS count FROM outreach_queue GROUP BY status ORDER BY count DESC`
    ),
    pool.query(
      `SELECT usage_day::text AS day, channel, sent_count::int AS sent
       FROM daily_usage WHERE usage_day >= CURRENT_DATE - 7
       ORDER BY usage_day DESC`
    )
  ]);

  return {
    generatedAt: new Date().toISOString(),
    prospects: {
      total: totals.rows[0].total,
      newToday: totals.rows[0].new_today,
      newLast7Days: totals.rows[0].new_7d,
      suppressed: totals.rows[0].suppressed,
      byStage: byStage.rows,
      byCampaignLast7Days: byCampaign.rows,
      topRated: topLeads.rows
    },
    outreach: {
      queueByStatus: queueByStatus.rows,
      sentByDay: sentByDay.rows
    }
  };
}

module.exports = { buildLeadsDigest };

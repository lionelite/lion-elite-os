'use strict';

// One answer to "what leads do we have, and are they still arriving".
//
// Three engines write leads and none of them had a surface: the Bluesky
// listener and the discovery worker write prospects under their own campaigns,
// and the opt-in page writes captured_leads. Asking the question meant a SQL
// prompt, which is why it went unanswered for so long — and why nobody noticed
// that all three were inert.
//
// Flow rates are the point. A total tells you what you once collected; the 24h
// and 7d counts tell you whether anything is arriving now.

const { query } = require('../database');

const SOURCES = Object.freeze({
  'bluesky-audience-leads': 'Bluesky — brand audiences',
  'bluesky-universal-leads': 'Bluesky — universal intent',
  'osm-business-discovery': 'Business discovery'
});

async function prospectSummary() {
  const result = await query(
    `SELECT campaign_id,
            count(*)::int AS total,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h,
            count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7d,
            max(created_at) AS newest,
            round(avg(score)) AS avg_score
     FROM prospects
     WHERE campaign_id = ANY($1)
     GROUP BY campaign_id`,
    [Object.keys(SOURCES)]
  );
  return result.rows.map(row => ({
    key: row.campaign_id,
    label: SOURCES[row.campaign_id] || row.campaign_id,
    total: row.total,
    last24h: row.last24h,
    last7d: row.last7d,
    newest: row.newest,
    averageScore: row.avg_score === null ? null : Number(row.avg_score)
  }));
}

async function capturedSummary() {
  const result = await query(
    `SELECT lane,
            count(*)::int AS total,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h,
            count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7d,
            count(*) FILTER (WHERE email_marketing_consent AND unsubscribed_at IS NULL)::int AS email_ok,
            count(*) FILTER (WHERE sms_marketing_consent AND unsubscribed_at IS NULL)::int AS sms_ok,
            count(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed,
            max(created_at) AS newest
     FROM captured_leads
     GROUP BY lane`
  );
  return result.rows.map(row => ({
    key: row.lane,
    label: row.lane === 'coach-platform' ? 'Opt-in — coaches wanting a platform' : 'Opt-in — coaching clients',
    total: row.total,
    last24h: row.last24h,
    last7d: row.last7d,
    emailReachable: row.email_ok,
    smsReachable: row.sms_ok,
    unsubscribed: row.unsubscribed,
    newest: row.newest
  }));
}

/** The newest leads across every engine, so the page shows actual people. */
async function recentLeads(limit = 25) {
  const [prospects, captured] = await Promise.all([
    query(
      `SELECT campaign_id, business, contact, score, created_at, enrichment
       FROM prospects WHERE campaign_id = ANY($1)
       ORDER BY created_at DESC LIMIT $2`,
      [Object.keys(SOURCES), limit]
    ),
    query(
      `SELECT lane, name, email, phone, source, created_at,
              email_marketing_consent, sms_marketing_consent
       FROM captured_leads ORDER BY created_at DESC LIMIT $1`,
      [limit]
    )
  ]);

  const rows = [
    ...prospects.rows.map(row => ({
      source: SOURCES[row.campaign_id] || row.campaign_id,
      name: row.business?.name || row.business?.displayName || row.business?.sourceDid || 'Unknown',
      detail: row.enrichment?.niche || row.business?.niche || '',
      email: row.contact?.email || null,
      phone: row.contact?.phone || row.business?.phone || null,
      link: row.business?.latestPostUrl || row.business?.profileUrl || row.business?.website || null,
      score: row.score === null ? null : Number(row.score),
      createdAt: row.created_at
    })),
    ...captured.rows.map(row => ({
      source: row.lane === 'coach-platform' ? 'Opt-in — coach' : 'Opt-in — client',
      name: row.name || row.email,
      detail: row.source,
      email: row.email,
      phone: row.phone,
      link: null,
      // An opt-in is a stronger signal than any scored match: they asked.
      score: null,
      consent: [row.email_marketing_consent ? 'email' : null, row.sms_marketing_consent ? 'sms' : null].filter(Boolean),
      createdAt: row.created_at
    }))
  ];

  return rows
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

async function buildLeadOverview({ limit = 25 } = {}) {
  const [prospects, captured, recent] = await Promise.all([
    prospectSummary(), capturedSummary(), recentLeads(limit)
  ]);
  const sources = [...prospects, ...captured];
  const totals = sources.reduce((acc, s) => ({
    total: acc.total + s.total,
    last24h: acc.last24h + s.last24h,
    last7d: acc.last7d + s.last7d
  }), { total: 0, last24h: 0, last7d: 0 });

  return {
    generatedAt: new Date().toISOString(),
    totals,
    // What the owner actually wants to know, stated rather than inferred.
    flowing: totals.last24h > 0,
    sources: sources.sort((a, b) => b.total - a.total),
    recent
  };
}

module.exports = { SOURCES, buildLeadOverview, prospectSummary, capturedSummary, recentLeads };

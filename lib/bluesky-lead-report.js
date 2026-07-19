'use strict';

const { PostgresProspectStore } = require('./postgres-prospect-store');

const CAMPAIGN_ID = 'bluesky-universal-leads';

async function buildBlueskyLeadReport({ limit = 50 } = {}) {
  const store = new PostgresProspectStore();
  const prospects = await store.list({ campaignId: CAMPAIGN_ID, status: 'active' });
  const ranked = prospects
    .map(prospect => ({
      prospectId: prospect.prospectId,
      score: Number(prospect.score || prospect.business?.opportunityScore || 0),
      niche: prospect.business?.niche || prospect.enrichment?.niche || 'Other / Emerging Opportunity',
      sourceDid: prospect.business?.sourceDid || prospect.contact?.blueskyDid || null,
      profileUrl: prospect.business?.profileUrl || prospect.contact?.blueskyProfileUrl || null,
      postUrl: prospect.business?.latestPostUrl || prospect.business?.sourceUrl || null,
      postText: prospect.business?.latestPostText || null,
      intentSignals: prospect.business?.intentSignals || prospect.enrichment?.intentSignals || [],
      valueSignals: prospect.business?.valueSignals || prospect.enrichment?.valueSignals || [],
      lastSeenAt: prospect.enrichment?.lastSeenAt || prospect.business?.latestPostAt || prospect.updatedAt,
      recentPosts: prospect.business?.recentPosts || []
    }))
    .sort((a, b) => b.score - a.score);

  const byNiche = new Map();
  for (const lead of ranked) {
    const current = byNiche.get(lead.niche) || { niche: lead.niche, leadCount: 0, totalScore: 0, topScore: 0 };
    current.leadCount += 1;
    current.totalScore += lead.score;
    current.topScore = Math.max(current.topScore, lead.score);
    byNiche.set(lead.niche, current);
  }

  const niches = [...byNiche.values()]
    .map(item => ({
      ...item,
      averageScore: item.leadCount ? Math.round(item.totalScore / item.leadCount) : 0,
      opportunityIndex: Math.min(100, Math.round((item.leadCount ? item.totalScore / item.leadCount : 0) * 0.75 + Math.min(25, item.leadCount * 3)))
    }))
    .sort((a, b) => b.opportunityIndex - a.opportunityIndex || b.topScore - a.topScore);

  return {
    campaignId: CAMPAIGN_ID,
    totalLeads: ranked.length,
    topLeads: ranked.slice(0, Math.max(1, Number(limit) || 50)),
    niches,
    generatedAt: new Date().toISOString()
  };
}

module.exports = { buildBlueskyLeadReport, CAMPAIGN_ID };

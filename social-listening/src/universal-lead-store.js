'use strict';

const { PostgresProspectStore } = require('../../lib/postgres-prospect-store');

const CAMPAIGN_ID = 'bluesky-universal-leads';
const store = new PostgresProspectStore();

function profileUrl(did) {
  return did ? `https://bsky.app/profile/${encodeURIComponent(did)}` : null;
}

async function persistUniversalLead(post, lead) {
  if (!process.env.DATABASE_URL) return { stored: false, reason: 'DATABASE_URL_NOT_CONFIGURED' };

  const business = {
    name: `Bluesky ${post.did}`,
    displayName: post.did,
    region: 'bluesky',
    sourcePlatform: 'bluesky',
    sourceDid: post.did,
    sourceUrl: post.url,
    profileUrl: profileUrl(post.did),
    niche: lead.niche,
    opportunityScore: lead.opportunityScore,
    latestPostText: post.text,
    latestPostUrl: post.url,
    latestPostRkey: post.rkey,
    latestPostAt: post.createdAt || new Date().toISOString(),
    intentSignals: lead.intentSignals,
    valueSignals: lead.valueSignals
  };

  const created = await store.create({
    business,
    contact: {
      blueskyDid: post.did,
      blueskyProfileUrl: profileUrl(post.did)
    },
    campaignId: CAMPAIGN_ID,
    ownerId: 'bluesky-listener'
  }, 'bluesky-listener');

  const prospect = created.prospect;
  const previousBusiness = prospect.business || {};
  const recentPosts = Array.isArray(previousBusiness.recentPosts) ? previousBusiness.recentPosts : [];
  const mergedPosts = [
    {
      rkey: post.rkey,
      url: post.url,
      text: post.text,
      createdAt: post.createdAt || null,
      seenAt: new Date().toISOString(),
      opportunityScore: lead.opportunityScore,
      niche: lead.niche
    },
    ...recentPosts.filter(item => item?.rkey !== post.rkey)
  ].slice(0, 10);

  const bestScore = Math.max(Number(prospect.score || 0), Number(lead.opportunityScore || 0));
  const updated = await store.update(prospect.prospectId, {
    business: {
      ...previousBusiness,
      ...business,
      recentPosts: mergedPosts
    },
    score: bestScore,
    enrichment: {
      ...(prospect.enrichment || {}),
      source: 'bluesky-listener',
      niche: lead.niche,
      latestOpportunityScore: lead.opportunityScore,
      intentSignals: lead.intentSignals,
      valueSignals: lead.valueSignals,
      lastSeenAt: new Date().toISOString()
    },
    nextAction: bestScore >= 70 ? 'review_high_priority_bluesky_lead' : 'monitor_bluesky_lead'
  }, 'bluesky-listener');

  return { stored: true, duplicate: created.duplicate, prospect: updated };
}

module.exports = { persistUniversalLead, CAMPAIGN_ID };

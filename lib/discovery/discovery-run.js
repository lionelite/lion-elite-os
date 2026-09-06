'use strict';

// One discovery pass: find businesses, read the contact address they publish
// on their own site, store them as prospects.
//
// Kept separate from the worker so it can be exercised without Redis, and so
// the network, the enrichment and the store are all injectable.

const { fetchBusinesses } = require('./osm-source');

const CAMPAIGN_ID = 'osm-business-discovery';

/** Search areas, worked through one per run so no single pass is huge. */
const DEFAULT_AREAS = Object.freeze([
  { label: 'columbus-oh', south: 39.85, west: -83.15, north: 40.15, east: -82.80 },
  { label: 'cleveland-oh', south: 41.40, west: -81.85, north: 41.60, east: -81.55 },
  { label: 'cincinnati-oh', south: 39.05, west: -84.65, north: 39.25, east: -84.35 }
]);

function pickArea(areas, index) {
  const list = areas.length ? areas : DEFAULT_AREAS;
  return list[Math.abs(Number(index) || 0) % list.length];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object} deps every side effect is injected
 * @param {number} deps.batchSize how many businesses to enrich and store
 * @param {number} deps.rotation which area to work this run
 */
async function runDiscovery({
  areas = DEFAULT_AREAS,
  categories,
  rotation = 0,
  batchSize = 25,
  enrichDelayMs = 1500,
  fetchImpl,
  enrichEmail,
  saveProspect,
  logger = console
} = {}) {
  const area = pickArea(areas, rotation);
  const summary = { campaign: CAMPAIGN_ID, area: area.label, found: 0, stored: 0, duplicates: 0, enriched: 0, errors: [] };

  const businesses = await fetchBusinesses({ area, categories, fetchImpl });
  summary.found = businesses.length;

  // Prefer listings we can actually reach: a website means an email may be
  // discoverable, which is what makes a prospect actionable.
  const ordered = businesses
    .slice()
    .sort((a, b) => Number(Boolean(b.website)) - Number(Boolean(a.website)))
    .slice(0, batchSize);

  for (const business of ordered) {
    let email = business.email;

    if (!email && business.website && enrichEmail) {
      try {
        // One site at a time, spaced out. These are small businesses' servers.
        const found = await enrichEmail({ name: business.name, website: business.website, domain: business.website });
        email = found?.email || found?.emails?.[0] || null;
        if (email) summary.enriched += 1;
      } catch (error) {
        summary.errors.push({ business: business.name, stage: 'enrich', detail: error.message });
      }
      if (enrichDelayMs) await sleep(enrichDelayMs);
    }

    try {
      const result = await saveProspect({
        business: {
          name: business.name,
          displayName: business.name,
          website: business.website,
          phone: business.phone,
          address: business.address,
          region: area.label,
          niche: business.category,
          sourcePlatform: 'openstreetmap',
          sourceRef: business.sourceRef
        },
        contact: { email: email || null, phone: business.phone || null },
        campaignId: CAMPAIGN_ID,
        ownerId: 'discovery-worker'
      });
      if (result?.duplicate) summary.duplicates += 1;
      else summary.stored += 1;
    } catch (error) {
      summary.errors.push({ business: business.name, stage: 'store', detail: error.message });
    }
  }

  logger.log?.(`[discovery] ${area.label}: found ${summary.found}, stored ${summary.stored}, dupes ${summary.duplicates}, emails ${summary.enriched}`);
  return summary;
}

module.exports = { CAMPAIGN_ID, DEFAULT_AREAS, runDiscovery, pickArea };

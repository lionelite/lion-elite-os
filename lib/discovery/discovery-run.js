'use strict';

// One discovery pass: find businesses, read the contact address they publish
// on their own site, store them as prospects.
//
// Kept separate from the worker so it can be exercised without Redis, and so
// the network, the enrichment and the store are all injectable.

const { fetchBusinessesByCategory } = require('./osm-source');
const { classifyContactKind } = require('../contacts/provider-ingest');

const CAMPAIGN_ID = 'osm-business-discovery';

/** Search areas, worked through one per run so no single pass is huge. */
// Search areas, worked one per run by rotation.
//
// These were three Ohio metros, and the live store shows why that mattered:
// every one of the 81 leads on record came from them, so a healthy Overpass
// still returned "found 32, already known 25" — the pipeline had run out of
// ground to cover and reported it as a quiet day. A working source with
// nowhere new to look produces exactly the same zero as a broken one.
//
// The Florida metros are where the campaigns actually sell: the med-spa
// research-supply campaign and the campaign-builder examples both target South
// Florida, and the storefront is Florida-facing. Ohio stays — the real-estate
// side works Cleveland, and the existing lead history is there.
//
// Every box is kept near a quarter-degree, well inside buildQuery's 2-degree
// guard. Tight boxes over a dense urban core are what Overpass answers
// quickly; a wide box over mostly water or farmland costs the same query and
// returns less.
const DEFAULT_AREAS = Object.freeze([
  { label: 'miami-fl', south: 25.70, west: -80.32, north: 25.95, east: -80.12 },
  { label: 'fort-lauderdale-fl', south: 26.05, west: -80.25, north: 26.25, east: -80.08 },
  { label: 'west-palm-beach-fl', south: 26.65, west: -80.14, north: 26.84, east: -80.02 },
  { label: 'boca-raton-fl', south: 26.32, west: -80.20, north: 26.44, east: -80.06 },
  { label: 'naples-fl', south: 26.08, west: -81.84, north: 26.28, east: -81.70 },
  { label: 'tampa-fl', south: 27.88, west: -82.56, north: 28.08, east: -82.38 },
  { label: 'orlando-fl', south: 28.44, west: -81.46, north: 28.62, east: -81.26 },
  { label: 'jacksonville-fl', south: 30.24, west: -81.76, north: 30.42, east: -81.54 },
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
  // Called before a business is enriched. Returning true skips it entirely.
  // Checking for a known business at save time would be too late: enrichment
  // runs first, so a repeat run would re-scrape a small business's site for a
  // record we already hold. Defaults to skipping nothing, so existing callers
  // behave exactly as before.
  skipBusiness = () => false,
  logger = console
} = {}) {
  const area = pickArea(areas, rotation);
  const summary = {
    campaign: CAMPAIGN_ID, area: area.label,
    found: 0, stored: 0, duplicates: 0, enriched: 0, skipped: 0,
    errors: [],
    // Which segments could not be reached this run. `found: 0` with an empty
    // list means the area really had nothing; `found: 0` with entries here
    // means we never looked. Reporting them as the same number is how a dead
    // pipeline stays invisible.
    unreachableCategories: [],
    // Addresses dropped for belonging to a person rather than a business.
    // Counted rather than silent: a sudden spike means the enrichment is
    // reading the wrong element on the page.
    personalEmailsRefused: 0
  };

  const { businesses, failures } = await fetchBusinessesByCategory({ area, categories, fetchImpl, logger });
  summary.found = businesses.length;
  summary.unreachableCategories = failures;

  // Prefer listings we can actually reach: a website means an email may be
  // discoverable, which is what makes a prospect actionable.
  const ordered = businesses
    .slice()
    .sort((a, b) => Number(Boolean(b.website)) - Number(Boolean(a.website)))
    .slice(0, batchSize);

  for (const business of ordered) {
    if (skipBusiness(business)) {
      summary.skipped += 1;
      continue;
    }

    let email = business.email;

    if (!email && business.website && enrichEmail) {
      try {
        // One site at a time, spaced out. These are small businesses' servers.
        const found = await enrichEmail({ name: business.name, website: business.website, domain: business.website });
        const candidate = found?.email || found?.emails?.[0] || null;

        // A small business often lists the owner's personal Gmail as its only
        // contact address, and the live store proves it: one harvested
        // aesthetics business came through carrying brianfritze310@gmail.com.
        //
        // The root cause was not a missing check. lib/email-enrichment.js's
        // classifyEmail already returns `eligible: false` for exactly this
        // case — the caller took `found.email` and never read the verdict. So
        // the enrichment's own judgement is honoured first, and the contact
        // kind is checked second. A signal that is computed and ignored is
        // worse than no signal: it makes the pipeline look guarded.
        //
        // The phone and the listing are still worth having, so the record is
        // kept and only the address is dropped.
        const enrichmentVerdict = found?.classification || found?.classified || null;
        const enrichmentRefused = enrichmentVerdict ? enrichmentVerdict.eligible === false : false;
        const kind = classifyContactKind(candidate, business.website);

        if (enrichmentRefused || kind === 'personal_email') {
          email = null;
          summary.personalEmailsRefused += 1;
        } else {
          email = candidate;
          if (email) summary.enriched += 1;
        }
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

  logger.log?.(`[discovery] ${area.label}: found ${summary.found}, stored ${summary.stored}, dupes ${summary.duplicates}, skipped ${summary.skipped}, emails ${summary.enriched}`);
  return summary;
}

module.exports = { CAMPAIGN_ID, DEFAULT_AREAS, runDiscovery, pickArea };

'use strict';

// The B2B half of lead harvest: real businesses with a published phone and,
// where their own site publishes one, an email.
//
// This reuses lib/discovery/runDiscovery rather than reimplementing it. That
// module already handles area rotation, website-first ordering, enrichment
// spacing and per-business error isolation; the only thing it needs is
// somewhere to put the result. In the worker that is Postgres. Here it is a
// file, because the whole point is producing leads without a database.
//
// Enrichment reads a business's OWN published contact page. No data broker,
// no people search, no personal contact details.

const { runDiscovery, DEFAULT_AREAS } = require('../discovery/discovery-run');
const { enrichBusinessEmail } = require('../email-enrichment');

/** Map a discovery record into the same lead shape the Bluesky harvest emits. */
function toLead({ business, contact }) {
  return {
    id: `osm:${business.sourceRef}`,
    source: 'openstreetmap',
    capturedAt: new Date().toISOString(),
    audience: 'med-spa-b2b',
    brand: 'wellness',
    lane: 'Med spas / aesthetics / wellness clinics (Lion Elite Wellness, RUO supply)',
    // OSM listings carry no intent signal, so they cannot be scored the way a
    // post is. Reachability is the only thing that separates them: an email
    // makes a lead actionable, a phone alone makes it a call.
    score: contact.email ? 70 : 50,
    name: business.name,
    handle: null,
    did: null,
    profileUrl: business.website || null,
    postUrl: null,
    postedAt: null,
    text: [business.niche, business.address].filter(Boolean).join(' · '),
    matchedQuery: `${business.region}/${business.niche}`,
    matchedTerms: { subject: [business.niche].filter(Boolean), intent: [], booster: [] },
    suggestedOpener: null,
    contactChannel: contact.email ? 'email' : 'phone',
    email: contact.email || null,
    phone: contact.phone || null,
    address: business.address || null,
    website: business.website || null,
    region: business.region
  };
}

/**
 * One discovery pass, collected in memory instead of written to a store.
 *
 * @param {number} opts.rotation which search area to work (the workflow passes
 *   the hour, so consecutive runs cover different cities instead of
 *   re-querying one until it is exhausted)
 * @param {Set<string>} opts.knownIds ids already harvested. Checked through
 *   runDiscovery's skipBusiness hook, which runs BEFORE enrichment — checking
 *   at save time would still have re-scraped the business's own site for a
 *   record we already hold.
 */
async function harvestBusinesses({
  rotation = 0,
  batchSize = 25,
  areas = DEFAULT_AREAS,
  knownIds = new Set(),
  fetchImpl,
  enrichImpl = enrichBusinessEmail,
  enrichDelayMs = 1500,
  logger = console
} = {}) {
  const leads = [];

  const summary = await runDiscovery({
    areas,
    rotation,
    batchSize,
    enrichDelayMs,
    fetchImpl,
    skipBusiness: (business) => knownIds.has(`osm:${business.sourceRef}`),
    enrichEmail: async (business) => {
      const result = await enrichImpl(business);
      return result?.status === 'verified' ? result : null;
    },
    saveProspect: async ({ business, contact }) => {
      // skipBusiness already filtered the known ones; this guards the case of
      // the same business appearing twice within a single Overpass response.
      const id = `osm:${business.sourceRef}`;
      if (knownIds.has(id)) return { duplicate: true };
      knownIds.add(id);
      leads.push(toLead({ business, contact }));
      return { duplicate: false };
    },
    logger
  });

  return { leads, summary };
}

module.exports = { harvestBusinesses, toLead };

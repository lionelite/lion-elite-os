'use strict';

// Commercial-concept intelligence: site selection + competitor gap analysis
// for a Lion Elite Beauty flagship — a luxury med spa + reformer Pilates +
// recovery destination bringing a Miami-upscale feel to affluent Cleveland
// suburbs. Same "intelligence mind" pattern as fha-househack.js: score a
// candidate location, and turn a competitor catalog into white-space.
//
// Data caveats (screening, not gospel): demographic tiers below are coarse
// and must be confirmed with current census / Esri tapestry data for the
// exact trade area; competitor records are a seed list to be verified and
// expanded from live sources (this environment can't crawl Maps/Yelp).

// Affluent Greater Cleveland trade areas, coarse affluence tier 1(high)-3.
// VERIFY household income / daytime population per site before committing.
const TARGET_SUBURBS = Object.freeze({
  'pepper pike': { tier: 1, side: 'east' },
  'hunting valley': { tier: 1, side: 'east' },
  'gates mills': { tier: 1, side: 'east' },
  'moreland hills': { tier: 1, side: 'east' },
  'chagrin falls': { tier: 1, side: 'east' },
  'beachwood': { tier: 1, side: 'east' },
  'orange': { tier: 1, side: 'east' },
  'shaker heights': { tier: 2, side: 'east' },
  'woodmere': { tier: 2, side: 'east' },
  'solon': { tier: 2, side: 'east' },
  'rocky river': { tier: 1, side: 'west' },
  'bay village': { tier: 1, side: 'west' },
  'westlake': { tier: 2, side: 'west' },
  'avon': { tier: 2, side: 'west' }
});

// The concept and its revenue lines. GLP-1 weight management is called out
// because search shows it is the fastest-growing med-spa service in the
// market — but it is a LICENSED MEDICAL service (physician/medical director,
// legit compounding pharmacy). That is a separate regulatory entity from
// lionelitewellness.com's research-use-only storefront; do not blur them.
const CONCEPT = Object.freeze({
  name: 'Lion Elite Beauty Flagship — Med Spa + Reformer Pilates + Recovery',
  pillars: ['med_spa_aesthetics', 'glp1_weight_management', 'reformer_pilates', 'recovery_wellness', 'membership'],
  positioning: 'luxury / Miami-upscale',
  differentiator: 'One membership-driven luxury destination combining aesthetics, medically-supervised weight management, reformer Pilates, and recovery — vs. the market\'s single-service operators.'
});

function clamp(n, min = 0, max = 100) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(min, Math.min(max, x)) : min;
}

function suburbInfo(name = '') {
  const key = String(name).trim().toLowerCase();
  for (const [suburb, info] of Object.entries(TARGET_SUBURBS)) {
    if (key.includes(suburb)) return { suburb, ...info };
  }
  return null;
}

/**
 * Score a candidate location for the concept. Location fields (all optional,
 * scored on what's present): suburb/city, medianHouseholdIncome, sqft,
 * parkingSpaces, retailCoTenancy (bool: upscale retail nearby), visibility
 * (0-100), zonedForMedical (bool), competitorsWithin3mi (count).
 */
function scoreLocation(location = {}, competitors = []) {
  const info = suburbInfo(location.suburb || location.city || location.address || '');
  const dims = {};

  // Demographics — prefer verified income; fall back to suburb tier.
  if (Number(location.medianHouseholdIncome) > 0) {
    dims.demographics = clamp((location.medianHouseholdIncome - 60000) / 1000);
  } else if (info) {
    dims.demographics = info.tier === 1 ? 90 : info.tier === 2 ? 72 : 55;
  } else {
    dims.demographics = 40; // outside the affluent target set
  }

  // Competition — some presence validates demand; saturation hurts. The
  // luxury-tier gap matters more than raw count (see gap analysis).
  const nearby = Number(location.competitorsWithin3mi || 0);
  const luxNearby = competitors.filter((c) => suburbInfo(c.location || '') &&
    (c.tier === 'luxury') && sameArea(c.location, location)).length;
  dims.competition = clamp(85 - nearby * 6 + (nearby > 0 ? 8 : 0) - luxNearby * 12);

  // Site fit — space for multi-service (aesthetics rooms + reformer floor +
  // recovery), parking, visibility, medical zoning.
  let site = 40;
  if (Number(location.sqft) >= 3500) site += 20; else if (Number(location.sqft) >= 2500) site += 10;
  if (Number(location.parkingSpaces) >= 15) site += 12;
  if (location.retailCoTenancy === true) site += 14;
  if (Number(location.visibility) > 0) site += clamp(location.visibility) * 0.14;
  if (location.zonedForMedical === true) site += 10;
  dims.site = clamp(site);

  // Synergy — co-locating aesthetics + Pilates + recovery is the moat.
  dims.synergy = clamp(70 + (Number(location.sqft) >= 4000 ? 20 : 0));

  const weights = { demographics: 0.34, competition: 0.24, site: 0.24, synergy: 0.18 };
  const overall = Number(
    Object.entries(weights).reduce((sum, [k, w]) => sum + dims[k] * w, 0).toFixed(2)
  );

  let recommendation = 'PASS';
  if (overall >= 75) recommendation = 'PURSUE';
  else if (overall >= 60) recommendation = 'WATCH';

  return {
    location: location.suburb || location.city || location.address || 'Unknown',
    targetSuburb: info ? info.suburb : null,
    affluenceTier: info ? info.tier : null,
    dimensions: dims,
    overall,
    recommendation
  };
}

function sameArea(a = '', b = {}) {
  const ai = suburbInfo(a);
  const bi = suburbInfo(b.suburb || b.city || b.address || '');
  return ai && bi && ai.suburb === bi.suburb;
}

/**
 * Turn a competitor catalog into white-space. Each competitor:
 * { name, location, type: 'medspa'|'pilates'|'wellness', services: [...],
 *   tier: 'value'|'mid'|'upscale'|'luxury', membership: bool }.
 */
function analyzeCompetitors(competitors = [], concept = CONCEPT) {
  const byType = {};
  const tierCounts = { value: 0, mid: 0, upscale: 0, luxury: 0 };
  const serviceCounts = {};
  let membershipCount = 0;
  let combinedConceptCount = 0; // offers BOTH aesthetics and pilates

  for (const c of competitors) {
    byType[c.type] = (byType[c.type] || 0) + 1;
    if (tierCounts[c.tier] != null) tierCounts[c.tier] += 1;
    if (c.membership) membershipCount += 1;
    for (const s of c.services || []) serviceCounts[s] = (serviceCounts[s] || 0) + 1;
    const svc = new Set(c.services || []);
    const hasAesthetics = [...svc].some((s) => /botox|filler|laser|facial|aesthetic|glp|semaglutide|tirzepatide|weight/i.test(s));
    const hasPilates = [...svc].some((s) => /pilates|reformer/i.test(s));
    if (hasAesthetics && hasPilates) combinedConceptCount += 1;
  }

  const whiteSpace = [];
  if ((tierCounts.luxury || 0) === 0) whiteSpace.push('No true LUXURY-tier operator — the Miami-upscale position is open.');
  if (combinedConceptCount === 0) whiteSpace.push('No one combines med-spa aesthetics + reformer Pilates under one roof — the integrated-destination concept is unclaimed.');
  if (membershipCount / Math.max(1, competitors.length) < 0.4) whiteSpace.push('Membership/recurring-revenue model is under-used — room for a premium membership.');
  if (!Object.keys(serviceCounts).some((s) => /recovery|cold plunge|sauna|iv|cryo/i.test(s))) {
    whiteSpace.push('Recovery (cold plunge / sauna / IV / cryo) is thin — a differentiator to bundle.');
  }

  return {
    total: competitors.length,
    byType,
    tierCounts,
    membershipShare: Number((membershipCount / Math.max(1, competitors.length)).toFixed(2)),
    combinedConceptCount,
    topServices: Object.entries(serviceCounts).sort((a, b) => b[1] - a[1]).slice(0, 8),
    whiteSpace
  };
}

module.exports = {
  CONCEPT,
  TARGET_SUBURBS,
  suburbInfo,
  scoreLocation,
  analyzeCompetitors
};

'use strict';

/**
 * Free fallback business source: OpenStreetMap's Nominatim search API.
 *
 * Used when Overpass (lib/discovery/osm-source.js) is unreachable, which is
 * what the first production run on Render hit: one Overpass mirror refused the
 * connection and the other two timed out, so discovery found nothing. Nominatim
 * is the same open map data served by a different cluster, and with
 * `extratags=1` it returns the website/phone/email tags enrichment needs.
 *
 * Usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * at most 1 request per second, an identifying User-Agent, no bulk scraping.
 * One run makes about ten small, bounded searches, spaced 1.1 s apart.
 *
 * Returns the same shape as fetchBusinessesByCategory: { businesses, failures, source }.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'LionEliteOS/1.0 (business discovery; contact via lionelitewellness.com)';

// Searches aimed at the campaign: aesthetic, hormone, weight-loss, longevity,
// regenerative and IV practices. Targeting still decides who is worth a
// record (lib/contacts/clinic-targeting.js); these only choose what to look at.
const SEARCH_TERMS = Object.freeze([
  'med spa', 'medical spa', 'aesthetics', 'wellness clinic', 'anti aging',
  'hormone', 'weight loss', 'iv therapy', 'longevity', 'regenerative medicine',
]);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function categoryFor(result, term) {
  const t = `${result.category || ''}:${result.type || ''}`;
  if (/amenity:(clinic|doctors)|healthcare:/.test(t)) return 'clinic';
  if (/beauty|spa/.test(t) || /spa|aesthetic/.test(term)) return 'med-spa';
  return 'clinic';
}

function toBusiness(result, term) {
  const tags = result.extratags || {};
  const name = result.name || String(result.display_name || '').split(',')[0].trim();
  const website = tags['contact:website'] || tags.website || tags.url || null;
  const phone = tags['contact:phone'] || tags.phone || null;
  if (!name || (!website && !phone)) return null;
  const a = result.address || {};
  const address = [[a.house_number, a.road].filter(Boolean).join(' '), a.city || a.town || a.village, a.state, a.postcode]
    .filter(Boolean).join(', ') || null;
  return {
    name,
    category: categoryFor(result, term),
    phone,
    website,
    email: tags['contact:email'] || tags.email || null,
    address,
    source: 'openstreetmap-nominatim',
    sourceRef: `${result.osm_type}/${result.osm_id}`,
    lat: result.lat ? Number(result.lat) : null,
    lon: result.lon ? Number(result.lon) : null,
  };
}

async function fetchBusinessesNominatim({
  area,
  terms = SEARCH_TERMS,
  fetchImpl = fetch,
  spacingMs = 1100,
  timeoutMs = 20_000,
  sleepImpl = wait,
  logger = console,
} = {}) {
  const businesses = [];
  const seen = new Set();
  const failures = [];
  for (let i = 0; i < terms.length; i += 1) {
    const term = terms[i];
    const params = new URLSearchParams({
      q: term, format: 'jsonv2', extratags: '1', addressdetails: '1', limit: '50', bounded: '1',
      viewbox: `${area.west},${area.north},${area.east},${area.south}`, countrycodes: 'us',
    });
    try {
      const response = await fetchImpl(`${ENDPOINT}?${params}`, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Nominatim responded ${response.status}`);
      const results = await response.json();
      for (const r of Array.isArray(results) ? results : []) {
        const b = toBusiness(r, term);
        if (!b || seen.has(b.sourceRef)) continue;
        seen.add(b.sourceRef);
        businesses.push(b);
      }
    } catch (error) {
      failures.push({ category: term, message: `${error.message}${error.cause?.code ? ` ${error.cause.code}` : ''}` });
      logger.warn?.(`[discovery] nominatim "${term}" unavailable (${error.message})`);
    }
    if (i < terms.length - 1) await sleepImpl(spacingMs);
  }
  if (failures.length === terms.length) throw new Error(`Nominatim unreachable: ${failures[0].message}`);
  return { businesses, failures, source: 'openstreetmap-nominatim' };
}

module.exports = { fetchBusinessesNominatim, toBusiness, SEARCH_TERMS, ENDPOINT };

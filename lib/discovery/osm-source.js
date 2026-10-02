'use strict';

// Business discovery from OpenStreetMap.
//
// This finds BUSINESSES from their own public listings — the trading name, the
// phone number they publish for customers, and their website, from which
// lib/email-enrichment.js reads the contact address they publish themselves.
// It is the same posture as the rest of the prospect pipeline: a business's own
// published details, never a data broker and never a private individual.
//
// Overpass is a free, donated, shared service. Being rude to it gets everyone
// blocked, so requests are bounded, spaced, and identified.

// Overpass mirrors, tried in order. The main instance is heavily
// oversubscribed and answers a large bbox query with 504 more often than not —
// the first live run failed exactly that way. The error was already flagged
// retryable; nothing retried it.
const ENDPOINTS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
]);

const DEFAULT_ENDPOINT = ENDPOINTS[0];

// Three mirrors at 90s each meant a fully saturated Overpass cost 4.5 minutes
// to discover, every two hours. Smaller per-category queries answer in seconds
// when the instance is healthy, so a long wait no longer buys anything.
const DEFAULT_TIMEOUT_MS = 45000;

// Statuses worth trying another mirror for: the instance is busy or broken,
// not the query. A 400 means the query itself is wrong and every mirror will
// reject it identically, so that one fails fast.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// OSM selectors for the segments the outreach campaigns actually target.
const CATEGORIES = Object.freeze({
  'med-spa': ['["shop"="beauty"]', '["amenity"="spa"]', '["leisure"="spa"]'],
  clinic: ['["amenity"="clinic"]', '["healthcare"="clinic"]'],
  gym: ['["leisure"="fitness_centre"]'],
  massage: ['["shop"="massage"]'],
  physiotherapy: ['["healthcare"="physiotherapist"]']
});

function categorySelectors(categories) {
  const wanted = (Array.isArray(categories) && categories.length ? categories : Object.keys(CATEGORIES))
    .filter(name => CATEGORIES[name]);
  if (!wanted.length) throw new Error(`No known categories. Valid: ${Object.keys(CATEGORIES).join(', ')}`);
  return wanted.flatMap(name => CATEGORIES[name].map(selector => ({ category: name, selector })));
}

// Overpass's `[timeout:N]` is the server's compute budget; `timeoutMs` is how
// long we wait. The two were set independently — a 60s server budget under a
// 90s client wait — so a saturated mirror burned the full 90s before failover
// and three mirrors cost four and a half minutes. Deriving one from the other
// keeps the server giving up first, which returns a real 504 we can act on
// instead of a client-side abort that tells us nothing.
const SERVER_BUDGET_HEADROOM_MS = 15000;

function serverBudgetFor(timeoutMs) {
  return Math.max(10, Math.round(((timeoutMs || DEFAULT_TIMEOUT_MS) - SERVER_BUDGET_HEADROOM_MS) / 1000));
}

/**
 * @param {object} area {south, west, north, east} degrees
 */
function buildQuery({ area, categories, timeoutSeconds = 60 } = {}) {
  const { south, west, north, east } = area || {};
  for (const [name, value] of Object.entries({ south, west, north, east })) {
    if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`area.${name} must be a number`);
  }
  if (south >= north || west >= east) throw new Error('area is inverted; expected south<north and west<east');
  // A runaway bounding box is how you time out Overpass and get rate limited.
  if ((north - south) > 2 || (east - west) > 2) throw new Error('area is too large; use boxes under 2 degrees');

  const bbox = `(${south},${west},${north},${east})`;
  // `nwr` matches nodes, ways and relations in a single union member. The
  // previous form emitted a separate `node` and `way` line per selector, so an
  // all-category query carried 18 members over a box up to 2 degrees a side.
  // That is the exact shape Overpass sheds first, and it is why every mirror
  // either 504'd or never answered.
  const clauses = categorySelectors(categories)
    .map(({ selector }) => `  nwr${selector}${bbox};`)
    .join('\n');

  return `[out:json][timeout:${timeoutSeconds}];\n(\n${clauses}\n);\nout center tags;`;
}

function firstTag(tags, keys) {
  for (const key of keys) {
    const value = String(tags[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function addressFrom(tags) {
  return [
    firstTag(tags, ['addr:housenumber']),
    firstTag(tags, ['addr:street']),
    firstTag(tags, ['addr:city']),
    firstTag(tags, ['addr:state']),
    firstTag(tags, ['addr:postcode'])
  ].filter(Boolean).join(' ').trim();
}

function categoryFor(tags) {
  for (const [name, selectors] of Object.entries(CATEGORIES)) {
    for (const selector of selectors) {
      const match = selector.match(/\["([^"]+)"="([^"]+)"\]/);
      if (match && tags[match[1]] === match[2]) return name;
    }
  }
  return 'other';
}

/**
 * Overpass response → business records.
 *
 * A listing with no name, or with neither a phone nor a website, is dropped:
 * there is nothing to act on and nothing to enrich from.
 */
function parseBusinesses(payload) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  const seen = new Set();
  const businesses = [];

  for (const element of elements) {
    const tags = element?.tags || {};
    const name = firstTag(tags, ['name', 'operator', 'brand']);
    if (!name) continue;

    const phone = firstTag(tags, ['contact:phone', 'phone', 'contact:mobile']);
    const website = firstTag(tags, ['contact:website', 'website', 'url']);
    if (!phone && !website) continue;

    // OSM ids are unique per type; the store dedupes again by fingerprint.
    const key = `${element.type}/${element.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    businesses.push({
      name,
      category: categoryFor(tags),
      phone: phone || null,
      website: website || null,
      // Only what OSM publishes. Present because some listings carry it; it is
      // the business's own published address, not a person's.
      email: firstTag(tags, ['contact:email', 'email']) || null,
      address: addressFrom(tags) || null,
      source: 'openstreetmap',
      sourceRef: key,
      lat: element.lat ?? element.center?.lat ?? null,
      lon: element.lon ?? element.center?.lon ?? null
    });
  }
  return businesses;
}

/**
 * Query Overpass. `fetchImpl` is injected so this is testable without network,
 * and so the caller controls timeouts.
 */
async function fetchFromEndpoint({ area, categories, endpoint, fetchImpl, timeoutMs, timeoutSeconds }) {
  const query = buildQuery({ area, categories, timeoutSeconds: timeoutSeconds ?? serverBudgetFor(timeoutMs) });
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Overpass asks that clients identify themselves.
      'user-agent': 'LionEliteOS/1.0 (business discovery; contact via lionelitewellness.com)'
    },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (RETRYABLE_STATUS.has(response.status)) {
    const error = new Error(`Overpass is rate limiting or overloaded (${response.status}); back off`);
    error.retryable = true;
    throw error;
  }
  if (!response.ok) throw new Error(`Overpass responded ${response.status}`);

  return parseBusinesses(await response.json());
}

/**
 * Query Overpass, moving to the next mirror when one is busy or unreachable.
 *
 * `fetchImpl` is injected so this is testable without network, and so the
 * caller controls timeouts. Passing an explicit `endpoint` pins the request to
 * that one instance and disables failover, which is what the tests want.
 */
async function fetchBusinesses({
  area,
  categories,
  endpoint,
  endpoints,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutSeconds,
  retryDelayMs = 2000,
  sleepImpl = wait,
  logger = console
} = {}) {
  const targets = endpoint ? [endpoint] : (endpoints && endpoints.length ? endpoints : ENDPOINTS);
  let lastError;

  for (let index = 0; index < targets.length; index += 1) {
    try {
      return await fetchFromEndpoint({ area, categories, endpoint: targets[index], fetchImpl, timeoutMs, timeoutSeconds });
    } catch (error) {
      // A timeout or a dropped connection is the same situation as a 504 from
      // this side: the instance did not answer, so try the next one.
      const worthAnotherMirror = error.retryable === true
        || error.name === 'TimeoutError'
        || error.name === 'AbortError'
        || error instanceof TypeError;

      if (!worthAnotherMirror) throw error;

      lastError = error;
      const remaining = targets.length - index - 1;
      logger.warn?.(`[discovery] ${targets[index]} unavailable (${error.message}); ${remaining} mirror(s) left`);

      if (remaining > 0) await sleepImpl(retryDelayMs * (index + 1));
    }
  }

  throw lastError;
}

/**
 * Query each category separately and merge the results.
 *
 * One union across every category was a single request Overpass had to satisfy
 * completely or not at all, so one heavy segment took the whole run down with
 * it — which is what happened: every scheduled harvest since the feature
 * shipped reported zero, because all-or-nothing meant nothing.
 *
 * Per-category queries are small enough to answer, and failure stops being
 * total: a segment that times out costs that segment. The failures are
 * returned rather than logged and dropped, because a caller that cannot tell
 * "nothing there" from "nobody answered" reports an empty pipeline as a quiet
 * success — the exact confusion the harvest digest already exists to prevent.
 *
 * Requests are sequential and spaced. Overpass is donated infrastructure, and
 * five small spaced queries ask less of it than one large one it burns its
 * whole budget on and then discards.
 */
async function fetchBusinessesByCategory({
  area,
  categories,
  spacingMs = 1200,
  sleepImpl = wait,
  logger = console,
  ...options
} = {}) {
  const wanted = (Array.isArray(categories) && categories.length ? categories : Object.keys(CATEGORIES))
    .filter(name => CATEGORIES[name]);
  if (!wanted.length) throw new Error(`No known categories. Valid: ${Object.keys(CATEGORIES).join(', ')}`);

  const businesses = [];
  const seen = new Set();
  const failures = [];
  let lastError;

  for (let index = 0; index < wanted.length; index += 1) {
    const category = wanted[index];
    try {
      const found = await fetchBusinesses({ ...options, area, categories: [category], sleepImpl, logger });
      for (const business of found) {
        if (seen.has(business.sourceRef)) continue;
        seen.add(business.sourceRef);
        businesses.push(business);
      }
    } catch (error) {
      lastError = error;
      failures.push({ category, message: String(error.message || error) });
      logger.warn?.(`[discovery] ${category} unavailable (${error.message})`);
    }

    if (index < wanted.length - 1) await sleepImpl(spacingMs);
  }

  // Every segment failed, so this is an unreachable source and not an empty
  // one. Throwing keeps that distinction at the boundary where callers already
  // handle it, instead of handing back a zero that reads like a quiet day.
  if (failures.length === wanted.length) throw lastError;

  return { businesses, failures, attempted: wanted };
}

module.exports = {
  CATEGORIES,
  ENDPOINTS,
  DEFAULT_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  buildQuery,
  parseBusinesses,
  fetchBusinesses,
  fetchBusinessesByCategory,
  fetchFromEndpoint
};

'use strict';

/**
 * Clinic discovery from OpenStreetMap via Overpass — one query per metro.
 *
 * Replaces the per-category, 45-second, Nominatim-backed search that delivered
 * 0–1 new clinics a day. What changed and why:
 *
 *   - Nominatim is gone from bulk search. It is a geocoder with a hard
 *     1 request/second policy, and it answered every bulk run with 429.
 *   - One Overpass query per metro bounding box, carrying every clinic tag at
 *     once, instead of one query per category. Each query is a single server
 *     slot; five small queries per metro meant five chances to be shed.
 *   - A 90-second server budget (`[timeout:90]`) with a client wait just above
 *     it, so the server gives up first and says so (a 504 we can retry) rather
 *     than the client aborting blind.
 *   - Mirrors rotate per metro, so consecutive metros land on different
 *     instances, and a failed attempt retries on the next mirror with
 *     exponential backoff (honouring Retry-After on a 429).
 *   - Only listings that publish a website: discovery's job is to find an
 *     address to write to, and a listing with no site has nowhere to read one.
 *
 * Tags searched (all require website or contact:website):
 *   amenity=clinic | amenity=doctors
 *   healthcare=*   (minus trades that never buy research supply — see EXCLUDED_HEALTHCARE)
 *   beauty=spa
 *   shop=beauty / leisure=spa, only when the NAME says med spa, aesthetic, IV,
 *   hormone, wellness, weight loss or longevity — a nail bar is not a prospect.
 *
 * Everything with side effects (fetch, sleep) is injected so this is testable
 * offline.
 */

const MIRRORS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
]);

const SERVER_TIMEOUT_SECONDS = 90;
// Client wait: the server budget plus transfer headroom.
const CLIENT_TIMEOUT_MS = (SERVER_TIMEOUT_SECONDS + 15) * 1000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Name terms that make a beauty/spa listing a clinical prospect. POSIX ERE as
// Overpass evaluates it (case-insensitive via `,i`). `iv` is bounded so that
// "Olive" or "Vivid" does not match.
const SPA_NAME_REGEX = [
  'med ?spa', 'medi ?spa', 'medical spa', 'aesthetic', 'esthetic',
  '(^|[^a-z])iv([^a-z]|$)', 'iv therapy', 'drip', 'infusion', 'hydration',
  'hormone', 'wellness', 'weight ?loss', 'longevity', 'anti.?aging', 'rejuvenat',
  'injectable', 'botox', 'laser', 'regenerat'
].join('|');

// healthcare=* values that are never a research-supply prospect. Filtered
// client-side: listing them in the query would cost the server a negation per
// element for no gain.
const EXCLUDED_HEALTHCARE = Object.freeze(new Set([
  'pharmacy', 'hospital', 'dentist', 'optometrist', 'audiologist', 'blood_donation', 'blood_bank',
  'laboratory', 'birthing_center', 'birthing_centre', 'midwife', 'psychotherapist', 'counselling',
  'speech_therapist', 'occupational_therapist', 'hospice', 'dialysis', 'vaccination_centre',
  'sample_collection', 'nursing_home', 'podiatrist', 'optician'
]));

const EXCLUDED_SPECIALITY = /paediatric|pediatric|dentist|orthodont|oncolog|psychiatr|ophthalm|optometr|obstetric|gynaecolog|gynecolog|fertility|radiolog|nephrolog|dialysis|veterinar|addiction|hospice|audiolog/i;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateArea(area) {
  const { south, west, north, east } = area || {};
  for (const [name, value] of Object.entries({ south, west, north, east })) {
    if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`area.${name} must be a number`);
  }
  if (south >= north || west >= east) throw new Error('area is inverted; expected south<north and west<east');
  if ((north - south) > 2 || (east - west) > 2) throw new Error('area is too large; use boxes under 2 degrees');
}

/** One Overpass QL query for one metro box. */
function buildClinicQuery(area, { timeoutSeconds = SERVER_TIMEOUT_SECONDS } = {}) {
  validateArea(area);
  const { south, west, north, east } = area;
  const site = '[~"^(website|contact:website)$"~"."]';
  const spaName = `["name"~"${SPA_NAME_REGEX}",i]`;
  return [
    `[out:json][timeout:${timeoutSeconds}][bbox:${south},${west},${north},${east}];`,
    '(',
    `  nwr["amenity"~"^(clinic|doctors)$"]${site};`,
    `  nwr["healthcare"]${site};`,
    `  nwr["beauty"="spa"]${site};`,
    `  nwr["shop"="beauty"]${spaName}${site};`,
    `  nwr["leisure"="spa"]${spaName}${site};`,
    ');',
    'out center tags;'
  ].join('\n');
}

const first = (tags, keys) => {
  for (const key of keys) {
    const value = String(tags[key] || '').trim();
    if (value) return value;
  }
  return '';
};

function addressFrom(tags) {
  return ['addr:housenumber', 'addr:street', 'addr:city', 'addr:state', 'addr:postcode']
    .map(key => String(tags[key] || '').trim()).filter(Boolean).join(' ') || null;
}

/** 'clinic' for medical listings, 'med-spa' for spa/beauty ones (clinic-targeting reads these). */
function categoryFor(tags) {
  if (/^(clinic|doctors)$/.test(tags.amenity || '') || (tags.healthcare && tags.healthcare !== 'yes')) return 'clinic';
  if (tags.healthcare === 'yes' && !tags.shop && !tags.leisure && !tags.beauty) return 'clinic';
  return 'med-spa';
}

/** Why a listing is dropped before anyone visits its site; null when kept. */
function exclusionReason(tags) {
  if (tags.healthcare && EXCLUDED_HEALTHCARE.has(tags.healthcare)) return `healthcare=${tags.healthcare}`;
  if (/^(hospital|pharmacy|dentist)$/.test(tags.amenity || '')) return `amenity=${tags.amenity}`;
  const speciality = tags['healthcare:speciality'] || '';
  if (speciality && EXCLUDED_SPECIALITY.test(speciality)) return `speciality=${speciality}`;
  return null;
}

function normaliseWebsite(raw) {
  const value = String(raw || '').trim().split(/[;\s]/)[0];
  if (!value) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Overpass JSON → clinic listings. Returns { listings, excluded, counts }. */
function parseClinicListings(payload) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  const seen = new Set();
  const listings = [];
  const excluded = {};
  const counts = { elements: elements.length, named: 0, withWebsite: 0 };
  for (const element of elements) {
    const tags = element?.tags || {};
    const ref = `${element.type}/${element.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const name = first(tags, ['name', 'brand', 'operator']);
    if (!name) continue;
    counts.named += 1;
    const website = normaliseWebsite(first(tags, ['website', 'contact:website']));
    if (!website) continue;
    counts.withWebsite += 1;
    const reason = exclusionReason(tags);
    if (reason) { excluded[reason] = (excluded[reason] || 0) + 1; continue; }
    listings.push({
      name,
      category: categoryFor(tags),
      website,
      phone: first(tags, ['contact:phone', 'phone']) || null,
      email: first(tags, ['contact:email', 'email']) || null,
      address: addressFrom(tags),
      speciality: tags['healthcare:speciality'] || null,
      osmTag: tags.healthcare ? `healthcare=${tags.healthcare}` : tags.amenity ? `amenity=${tags.amenity}` : tags.beauty ? `beauty=${tags.beauty}` : tags.shop ? `shop=${tags.shop}` : tags.leisure ? `leisure=${tags.leisure}` : null,
      source: 'openstreetmap',
      sourceRef: ref,
      lat: element.lat ?? element.center?.lat ?? null,
      lon: element.lon ?? element.center?.lon ?? null
    });
  }
  return { listings, excluded, counts };
}

function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) * 1000 : 0;
}

/**
 * Query one metro with mirror rotation and exponential backoff.
 *
 * @param {number} rotation which mirror to start on (pass the metro's index so
 *        consecutive metros spread across instances)
 * @returns {{ listings, excluded, mirror, attempts: [{mirror, outcome, ms}] }}
 * @throws after maxAttempts, with `.attempts` attached
 */
async function fetchClinicListings({
  area,
  rotation = 0,
  mirrors = MIRRORS,
  maxAttempts = 6,
  baseBackoffMs = 5000,
  maxBackoffMs = 60000,
  timeoutMs = CLIENT_TIMEOUT_MS,
  userAgent = 'LionEliteOS/2.0 (clinic discovery)',
  fetchImpl = fetch,
  sleepImpl = wait,
  logger = console
} = {}) {
  const query = buildClinicQuery(area);
  const attempts = [];
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const mirror = mirrors[(Math.abs(rotation) + attempt) % mirrors.length];
    const started = Date.now();
    let waitHint = 0;
    try {
      const response = await fetchImpl(mirror, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent, accept: 'application/json' },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) {
        waitHint = retryAfterMs(response);
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = RETRYABLE_STATUS.has(response.status);
        throw error;
      }
      const payload = await response.json();
      // Overpass reports a server-side timeout inside a 200 body as `remark`.
      if (payload?.remark && /runtime error|timed out|out of memory/i.test(payload.remark) && !(payload.elements || []).length) {
        const error = new Error(`server remark: ${String(payload.remark).slice(0, 120)}`);
        error.retryable = true;
        throw error;
      }
      const parsed = parseClinicListings(payload);
      attempts.push({ mirror, outcome: 'ok', ms: Date.now() - started });
      return { ...parsed, mirror, attempts };
    } catch (error) {
      const retryable = error.retryable === true || error.retryable === undefined;
      const outcome = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : error.message;
      attempts.push({ mirror, outcome, ms: Date.now() - started });
      lastError = error;
      if (!retryable) break;
      if (attempt < maxAttempts - 1) {
        const backoff = Math.max(waitHint, Math.min(maxBackoffMs, baseBackoffMs * 2 ** attempt));
        logger.warn?.(`[overpass] ${area.label || 'area'}: ${new URL(mirror).hostname} ${outcome}; retry ${attempt + 2}/${maxAttempts} in ${Math.round(backoff / 1000)}s`);
        await sleepImpl(backoff);
      }
    }
  }
  const error = new Error(`Overpass unreachable for ${area.label || 'area'} after ${attempts.length} attempt(s): ${lastError?.message || 'unknown'}`);
  error.attempts = attempts;
  throw error;
}

module.exports = {
  MIRRORS,
  SERVER_TIMEOUT_SECONDS,
  CLIENT_TIMEOUT_MS,
  SPA_NAME_REGEX,
  EXCLUDED_HEALTHCARE,
  buildClinicQuery,
  parseClinicListings,
  fetchClinicListings,
  categoryFor,
  exclusionReason,
  normaliseWebsite
};

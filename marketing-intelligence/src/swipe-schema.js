'use strict';

// Swipe Intelligence — the record contract for one reverse-engineered,
// money-making ad + landing-page system. This is a SWIPE FILE, not a copy
// bank: every row captures WHAT a proven advertiser did and WHY we think it
// worked, so we can extract patterns and adapt them — never clone them.
//
// INTEGRITY RULE (enforced here): a row must not fabricate specifics. Fields
// we haven't actually inspected (a real ad's hook/headline/CTA, the landing
// page structure) stay null and are listed in `research.gaps`. Reported
// performance numbers carry their source and a verification status, so an
// unverified vendor-published figure is never silently treated as fact.

// How the creative is executed. Drives one of the strongest winner patterns.
const CREATIVE_FORMATS = Object.freeze(['ugc', 'founder', 'static', 'demonstration', 'testimonial', 'mixed', 'unknown']);

// How confident we are in the reported performance figures.
const VERIFICATION = Object.freeze([
  'reported-by-source', // a case-study publisher (Replo/Triple Whale/etc.) reported it; not independently verified by us
  'self-reported',      // the brand/operator claimed it
  'measured-by-us',     // our own analytics produced it
  'unverified'          // heard/estimated, no citation
]);

// Metric direction so a "-37% CPA" reads as good and "+147% sales" reads as
// good without a human re-reading each row.
const DIRECTIONS = Object.freeze(['increase', 'decrease']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateMetric(metric, path, errors) {
  if (!metric || typeof metric !== 'object') {
    errors.push(`${path}: metric must be an object`);
    return;
  }
  if (!isNonEmptyString(metric.name)) errors.push(`${path}.name is required`);
  if (typeof metric.value !== 'number' || Number.isNaN(metric.value)) errors.push(`${path}.value must be a number`);
  if (metric.direction && !DIRECTIONS.includes(metric.direction)) {
    errors.push(`${path}.direction must be one of ${DIRECTIONS.join('/')}`);
  }
}

/**
 * Validate a swipe entry. Returns { valid, errors, warnings }.
 * - errors  → the row is structurally unusable.
 * - warnings → the row is usable but has honesty gaps (unresearched creative
 *   fields, performance with no source) that keep it out of the "verified
 *   winner" pool until filled.
 */
function validateEntry(entry) {
  const errors = [];
  const warnings = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['entry must be an object'], warnings };
  }

  for (const field of ['id', 'brand', 'industry']) {
    if (!isNonEmptyString(entry[field])) errors.push(`${field} is required`);
  }

  const creative = entry.creative || {};
  if (creative.format && !CREATIVE_FORMATS.includes(creative.format)) {
    errors.push(`creative.format must be one of ${CREATIVE_FORMATS.join('/')}`);
  }

  const perf = entry.performance || {};
  const metrics = Array.isArray(perf.metrics) ? perf.metrics : [];
  metrics.forEach((m, i) => validateMetric(m, `performance.metrics[${i}]`, errors));
  if (perf.verificationStatus && !VERIFICATION.includes(perf.verificationStatus)) {
    errors.push(`performance.verificationStatus must be one of ${VERIFICATION.join('/')}`);
  }
  if (metrics.length && !isNonEmptyString((entry.source || {}).name)) {
    warnings.push('performance metrics present but no source.name — treat as unverified');
  }

  // Honesty warnings: unresearched creative fields the swipe file is meant to
  // hold. These do not invalidate the row; they flag it as incomplete.
  const creativeGaps = ['openingHook', 'headline', 'cta', 'visualStyle'].filter((k) => !isNonEmptyString(creative[k]));
  if (creativeGaps.length) warnings.push(`unresearched creative fields: ${creativeGaps.join(', ')}`);
  if (!isNonEmptyString((entry.funnel || {}).landingPageStructure)) warnings.push('landing-page structure not yet inspected');
  if (!isNonEmptyString(entry.hypothesis)) warnings.push('no "why we think it worked" hypothesis recorded');

  return { valid: errors.length === 0, errors, warnings };
}

// A blank, correctly-shaped entry so new rows start honest (nulls, not
// invented values) and the research gaps are explicit.
function blankEntry(overrides = {}) {
  return {
    id: null,
    brand: null,
    product: null,
    industry: null,
    price: null, // { amount, currency, aov, note }
    offer: null,
    creative: { openingHook: null, visualStyle: null, format: 'unknown', headline: null, cta: null },
    funnel: { adLandingCongruence: null, landingPageStructure: null, socialProof: null },
    performance: { metrics: [], reportedSpend: null, verificationStatus: 'unverified' },
    source: { name: null, url: null },
    hypothesis: null,
    tags: [],
    addedAt: new Date().toISOString().slice(0, 10),
    research: { complete: false, gaps: [] },
    ...overrides
  };
}

// Does this row clear the bar to count as a "winner" for pattern mining?
// At least one positive, sourced performance metric.
function isWinner(entry) {
  const perf = entry.performance || {};
  const metrics = Array.isArray(perf.metrics) ? perf.metrics : [];
  const sourced = isNonEmptyString((entry.source || {}).name);
  return sourced && metrics.some((m) => typeof m.value === 'number' && m.value > 0);
}

module.exports = {
  CREATIVE_FORMATS,
  VERIFICATION,
  DIRECTIONS,
  validateEntry,
  blankEntry,
  isWinner
};

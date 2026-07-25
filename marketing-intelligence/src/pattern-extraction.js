'use strict';

// Pattern extraction — the actual point of the swipe file. Given the WINNERS
// (rows with reported positive results), find what they SHARE: creative
// formats, tags/levers, ad-landing congruence, price bands, industries. The
// output is directional evidence for what to test at Lion Elite, never a
// mandate to copy.
//
// HONESTY: with a small seed, "patterns" are hypotheses. Every result carries
// its support count and share, and the report labels low-sample findings so
// we don't over-trust 2-of-7 coincidences.

const { isWinner } = require('./swipe-schema');

function tally(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return counts;
}

function toRanked(counts, sampleSize) {
  return [...counts.entries()]
    .map(([value, support]) => ({ value, support, share: sampleSize ? support / sampleSize : 0 }))
    .sort((a, b) => b.support - a.support || String(a.value).localeCompare(String(b.value)));
}

// Price band from a price object, if we actually have an amount.
function priceBand(price) {
  const amt = price && typeof price.amount === 'number' ? price.amount : (price && typeof price.aov === 'number' ? price.aov : null);
  if (amt == null) return null;
  if (amt < 25) return '<$25';
  if (amt < 50) return '$25–49';
  if (amt < 100) return '$50–99';
  if (amt < 200) return '$100–199';
  return '$200+';
}

/**
 * Extract patterns across a set of winner entries.
 * @param {object[]} winners
 * @param {object} [opts]
 * @param {number} [opts.minSupport=2] minimum winners exhibiting a trait to report it
 */
function extractPatterns(winners, opts = {}) {
  const minSupport = opts.minSupport != null ? opts.minSupport : 2;
  const n = winners.length;

  const formatCounts = tally(winners.map((w) => (w.creative || {}).format || 'unknown').filter((f) => f !== 'unknown'));
  const tagCounts = tally(winners.flatMap((w) => Array.isArray(w.tags) ? w.tags : []));
  const industryCounts = tally(winners.map((w) => w.industry).filter((i) => i && i !== 'unresearched'));
  const priceCounts = tally(winners.map((w) => priceBand(w.price)).filter(Boolean));

  const congruent = winners.filter((w) => (w.funnel || {}).adLandingCongruence);

  const notable = (ranked) => ranked.filter((r) => r.support >= minSupport);

  return {
    sampleSize: n,
    lowSample: n < 5,
    formats: notable(toRanked(formatCounts, n)),
    levers: notable(toRanked(tagCounts, n)), // tags ARE the levers/tactics
    industries: notable(toRanked(industryCounts, n)),
    priceBands: notable(toRanked(priceCounts, n)),
    adLandingSystem: {
      support: congruent.length,
      share: n ? congruent.length / n : 0,
      brands: congruent.map((w) => w.brand)
    },
    // Even below minSupport, keep the full lever ranking for transparency.
    allLevers: toRanked(tagCounts, n)
  };
}

/**
 * Turn extracted patterns into candidate SOP proposals — phrased as tests to
 * run, not laws. Each proposal names the supporting winners so it's auditable.
 */
function proposeCandidates(patterns, winners) {
  const proposals = [];
  const brandsWithTag = (tag) => winners.filter((w) => (w.tags || []).includes(tag)).map((w) => w.brand);

  for (const lever of patterns.levers) {
    proposals.push({
      patternId: `lever:${lever.value}`,
      statement: `Test "${lever.value}" — shared by ${lever.support}/${patterns.sampleSize} winners (${Math.round(lever.share * 100)}%).`,
      support: lever.support,
      evidence: brandsWithTag(lever.value),
      status: 'candidate'
    });
  }
  if (patterns.adLandingSystem.support >= 2) {
    proposals.push({
      patternId: 'system:ad-landing-congruence',
      statement: `Treat ad + landing page as ONE system — ${patterns.adLandingSystem.support} winners show congruence/landing-page-driven lifts.`,
      support: patterns.adLandingSystem.support,
      evidence: patterns.adLandingSystem.brands,
      status: 'candidate'
    });
  }
  for (const fmt of patterns.formats) {
    proposals.push({
      patternId: `format:${fmt.value}`,
      statement: `Test "${fmt.value}" creative — present in ${fmt.support}/${patterns.sampleSize} winners.`,
      support: fmt.support,
      evidence: winners.filter((w) => (w.creative || {}).format === fmt.value).map((w) => w.brand),
      status: 'candidate'
    });
  }
  return proposals.sort((a, b) => b.support - a.support);
}

module.exports = { extractPatterns, proposeCandidates, priceBand, isWinner };

'use strict';

// Synonym/keyword classifier for firehose posts. Deterministic and
// explainable: every match reports exactly which subject, intent, and
// booster terms fired, so a human reviewing the feed can see WHY a post
// was surfaced. An optional local model (see ollama-intent.js) can refine
// these results; it can only downgrade or annotate, never auto-engage.

const { AUDIENCE_PROFILES } = require('./audience-profiles');

// Terms are matched on word boundaries, case-insensitively. Multi-word
// terms match as phrases with flexible whitespace.
function termToPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // \b misbehaves around non-word edge characters like "+" (nad+) or a
  // leading digit boundary, so use lookarounds on word characters.
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
}

// Precompile per-audience patterns once.
const COMPILED = new Map();
for (const profile of Object.values(AUDIENCE_PROFILES)) {
  COMPILED.set(profile.key, {
    profile,
    subject: profile.subjectTerms.map((t) => ({ term: t, pattern: termToPattern(t) })),
    intent: profile.intentTerms.map((t) => ({ term: t, pattern: termToPattern(t) })),
    booster: profile.boosterTerms.map((t) => ({ term: t, pattern: termToPattern(t) }))
  });
}

function matchTerms(text, entries) {
  const hits = [];
  for (const { term, pattern } of entries) {
    if (pattern.test(text)) hits.push(term);
  }
  return hits;
}

/**
 * Score one post against one audience.
 * Relevance requires BOTH a subject hit and an intent hit — a post that
 * merely mentions peptides (news, jokes) or merely says "looking for"
 * (anything else) never matches.
 */
function scoreForAudience(text, compiled) {
  const subjectHits = matchTerms(text, compiled.subject);
  if (subjectHits.length === 0) return null;
  const intentHits = matchTerms(text, compiled.intent);
  if (intentHits.length === 0) return null;
  const boosterHits = matchTerms(text, compiled.booster);

  const score = Math.min(
    100,
    40 +
      Math.min(20, (subjectHits.length - 1) * 10) +
      Math.min(20, (intentHits.length - 1) * 10) +
      Math.min(20, boosterHits.length * 5)
  );

  const doNotEngageHits = compiled.profile.doNotEngagePatterns
    .map((pattern) => {
      const match = text.match(pattern);
      return match ? match[0] : null;
    })
    .filter(Boolean);
  const doNotEngage = doNotEngageHits.length > 0;

  return {
    audience: compiled.profile.key,
    brand: compiled.profile.brand,
    score,
    matched: { subject: subjectHits, intent: intentHits, booster: boosterHits },
    doNotEngage,
    doNotEngageMatches: doNotEngageHits,
    doNotEngageReason: doNotEngage ? compiled.profile.doNotEngageReason : null,
    // Openers are suggestions for a HUMAN to adapt and send manually after
    // reading the post. Nothing in this tool transmits them anywhere.
    suggestedOpener: doNotEngage ? null : compiled.profile.suggestedOpener
  };
}

/**
 * Classify a post's text against every audience profile.
 * Returns { relevant, matches } where matches is sorted by score.
 */
function classifyPost(text, { audiences } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { relevant: false, matches: [] };
  }
  const keys = audiences || [...COMPILED.keys()];
  const matches = [];
  for (const key of keys) {
    const compiled = COMPILED.get(key);
    if (!compiled) throw new Error(`Unknown audience: ${key}`);
    const result = scoreForAudience(text, compiled);
    if (result) matches.push(result);
  }
  matches.sort((a, b) => b.score - a.score);
  return { relevant: matches.length > 0, matches };
}

module.exports = { classifyPost, termToPattern };

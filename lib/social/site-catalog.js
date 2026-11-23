'use strict';

// Ground social captions in the real lionelitewellness.com product copy.
//
// The live storefront is a custom Orchids build (no Shopify products.json,
// no product API), so product info is extracted from the rendered HTML of
// product pages. Because that copy is written for a storefront and may
// contain human-use / benefit language that LEW's research-use-only social
// posts must never carry, every sentence pulled from the site is run
// through the fail-closed compliance validator individually — only
// research-safe sentences survive into a caption. Nothing here fetches;
// scripts/fetch-site-catalog.js does the network part (in CI, where the
// site is reachable) and hands HTML/text to these pure, testable functions.

const { validateContent } = require('./social-compliance');
const { WELLNESS_DISCLAIMER } = require('./brand-profiles');

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html, regex) {
  const m = String(html || '').match(regex);
  return m ? stripTags(m[1]) : '';
}

/**
 * Extract a product record from a rendered product page. Generic (no
 * Orchids-specific selectors, which aren't documented): title, meta
 * description, first H1, and the readable body text.
 */
function extractProduct(html, url) {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const metaDesc =
    firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    firstMatch(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const bodyText = stripTags(html);
  return {
    url: url || null,
    name: (h1 || title || '').replace(/\s*[|\-–—]\s*Lion Elite.*$/i, '').trim(),
    description: metaDesc || '',
    text: bodyText.slice(0, 4000)
  };
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15 && s.length <= 300);
}

/**
 * Keep only the sentences from site copy that individually pass the
 * research-only compliance validator (disclaimer not required per sentence).
 */
function compliantSentences(text, limit = 3) {
  const kept = [];
  for (const sentence of splitSentences(text)) {
    const { approved } = validateContent({ text: sentence, complianceMode: 'research-only', requireDisclaimer: false });
    if (approved) kept.push(sentence);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * Build a caption grounded in the site's own words, guaranteed compliant.
 * Returns null when the site copy yields no research-safe sentences (the
 * caller then falls back to the catalog's default caption).
 */
function buildSiteSourcedCaption(name, siteText, { disclaimer = WELLNESS_DISCLAIMER } = {}) {
  const sentences = compliantSentences(siteText, 3);
  if (sentences.length === 0) return null;
  const body = sentences.join(' ');
  const caption = `${name}. ${body} ${disclaimer}`;
  // Final whole-caption gate: the assembled result must still pass, incl.
  // the disclaimer requirement.
  const { approved } = validateContent({ text: caption, complianceMode: 'research-only' });
  return approved ? caption : null;
}

// Match a site product record to a catalog peptide by normalized name.
function matchPeptide(siteRecord, peptideCatalog) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hay = `${norm(siteRecord.name)} ${norm(siteRecord.url)}`;
  return peptideCatalog.find((p) => hay.includes(norm(p.name)) || hay.includes(norm(p.slug))) || null;
}

module.exports = {
  stripTags,
  extractProduct,
  splitSentences,
  compliantSentences,
  buildSiteSourcedCaption,
  matchPeptide
};

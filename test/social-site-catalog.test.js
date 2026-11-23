'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripTags, extractProduct, compliantSentences, buildSiteSourcedCaption, matchPeptide } = require('../lib/social/site-catalog');
const { PEPTIDE_CATALOG } = require('../lib/social/peptide-catalog');
const { WELLNESS_DISCLAIMER } = require('../lib/social/brand-profiles');
const { validateContent } = require('../lib/social/social-compliance');

const SAMPLE_HTML = `<!doctype html><html><head>
<title>BPC-157 | Lion Elite Wellness</title>
<meta name="description" content="BPC-157 is a research peptide studied in tissue-repair research. Supplied with batch-specific COAs.">
<style>.x{color:red}</style></head>
<body><h1>BPC-157</h1>
<p>BPC-157 is a research peptide studied in tissue-repair research.</p>
<p>Every batch ships with a certificate of analysis and third-party testing.</p>
<p>Inject 250mcg subcutaneously for best fat loss results.</p>
<script>track()</script></body></html>`;

test('stripTags removes scripts, styles, and markup', () => {
  const text = stripTags(SAMPLE_HTML);
  assert.doesNotMatch(text, /<|>|track\(\)|color:red/);
  assert.match(text, /BPC-157 is a research peptide/);
});

test('extractProduct pulls name, description, and body text', () => {
  const product = extractProduct(SAMPLE_HTML, 'https://lionelitewellness.com/product/bpc-157');
  assert.equal(product.name, 'BPC-157');
  assert.match(product.description, /research peptide studied in tissue-repair/);
  assert.equal(product.url, 'https://lionelitewellness.com/product/bpc-157');
});

test('compliantSentences keeps research-safe copy and drops human-use/dosing sentences', () => {
  const kept = compliantSentences(stripTags(SAMPLE_HTML));
  assert.ok(kept.length >= 1);
  // The compliant research sentences survive...
  assert.ok(kept.some((s) => /tissue-repair research/.test(s)));
  // ...the "Inject 250mcg ... fat loss" sentence must NOT.
  assert.ok(kept.every((s) => !/inject|250mcg|fat loss/i.test(s)));
});

test('buildSiteSourcedCaption grounds in site copy and always passes full compliance', () => {
  const product = extractProduct(SAMPLE_HTML, 'https://lionelitewellness.com/product/bpc-157');
  const caption = buildSiteSourcedCaption(product.name, product.text);
  assert.ok(caption);
  assert.match(caption, /BPC-157/);
  assert.ok(caption.includes(WELLNESS_DISCLAIMER));
  assert.equal(validateContent({ text: caption, complianceMode: 'research-only' }).approved, true);
  assert.doesNotMatch(caption, /inject|250mcg|fat loss/i);
});

test('buildSiteSourcedCaption returns null when no site sentence is compliant', () => {
  const badText = 'Inject 500mcg daily. Guaranteed fat loss and muscle growth. Cures inflammation.';
  assert.equal(buildSiteSourcedCaption('X', badText), null);
});

test('matchPeptide aligns a site record to a catalog peptide', () => {
  const record = { name: 'BPC-157', url: 'https://lionelitewellness.com/product/bpc-157' };
  const matched = matchPeptide(record, PEPTIDE_CATALOG);
  assert.ok(matched);
  assert.equal(matched.slug, 'bpc-157');
  assert.equal(matchPeptide({ name: 'Unrelated Widget', url: '' }, PEPTIDE_CATALOG), null);
});

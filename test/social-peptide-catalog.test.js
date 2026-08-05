'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PEPTIDE_CATALOG, EXCLUDED_PRODUCTS, peptideForDate } = require('../lib/social/peptide-catalog');
const { validateContent } = require('../lib/social/social-compliance');
const { WELLNESS_DISCLAIMER } = require('../lib/social/brand-profiles');

test('every peptide caption passes fail-closed research-only compliance', () => {
  assert.ok(PEPTIDE_CATALOG.length >= 15);
  for (const peptide of PEPTIDE_CATALOG) {
    const result = validateContent({ text: peptide.caption, complianceMode: 'research-only' });
    assert.equal(result.approved, true, `${peptide.name} blocked: ${JSON.stringify(result.blockers)}`);
    assert.ok(peptide.caption.includes(WELLNESS_DISCLAIMER), `${peptide.name} missing disclaimer`);
  }
});

test('controlled/unlisted products are excluded, not in the catalog', () => {
  const slugs = new Set(PEPTIDE_CATALOG.map((p) => p.name.toLowerCase()));
  for (const banned of ['testosterone cypionate', 'melanotan ii', 'pt-141']) {
    assert.equal(slugs.has(banned), false, `${banned} must not be in the catalog`);
  }
  const excludedNames = EXCLUDED_PRODUCTS.map((e) => e.name);
  assert.ok(excludedNames.includes('Testosterone Cypionate'));
  assert.ok(EXCLUDED_PRODUCTS.every((e) => typeof e.reason === 'string' && e.reason.length > 0));
});

test('every peptide has a non-empty, claim-free image prompt', () => {
  for (const peptide of PEPTIDE_CATALOG) {
    assert.ok(peptide.imagePrompt.length > 40);
    // Image prompt must not smuggle in benefit/claim language.
    assert.doesNotMatch(peptide.imagePrompt, /\b(cure|treat|boost|anti-aging|fat loss|muscle growth)\b/i);
  }
});

test('peptideForDate maps days deterministically and wraps', () => {
  const start = '2026-07-19';
  assert.equal(peptideForDate('2026-07-19', start).peptide.slug, PEPTIDE_CATALOG[0].slug);
  assert.equal(peptideForDate('2026-07-20', start).peptide.slug, PEPTIDE_CATALOG[1].slug);
  assert.equal(peptideForDate('2026-07-19', start).dayNumber, 1);
  // Wraps after the catalog length.
  const wrapDate = new Date(Date.UTC(2026, 6, 19) + PEPTIDE_CATALOG.length * 86400000).toISOString().slice(0, 10);
  assert.equal(peptideForDate(wrapDate, start).peptide.slug, PEPTIDE_CATALOG[0].slug);
});

test('captions never contain dosing, human-use, or transformation language', () => {
  for (const peptide of PEPTIDE_CATALOG) {
    const text = peptide.caption.toLowerCase();
    assert.doesNotMatch(text, /\b\d+\s*(mg|mcg|iu|ml)\b/, `${peptide.name} has a dose`);
    assert.doesNotMatch(text, /\binject|reconstitut|subcutaneous|your (cycle|stack|protocol)\b/, `${peptide.name} has human-use language`);
    assert.doesNotMatch(text, /\b(fat|weight) loss|muscle growth|anti-aging (benefit|effect)|boosts? your\b/, `${peptide.name} has a transformation claim`);
  }
});

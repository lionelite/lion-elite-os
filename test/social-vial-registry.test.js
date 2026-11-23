'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKey, vialRelPath, products, resolveVial, coverage } = require('../lib/social/vial-registry');
const { PEPTIDE_CATALOG } = require('../lib/social/peptide-catalog');

test('normalizeKey lowercases, drops "and", and dashes non-alphanumerics', () => {
  assert.equal(normalizeKey('CJC-1295 / Ipamorelin'), 'cjc-1295-ipamorelin');
  assert.equal(normalizeKey('BPC-157 and TB-500'), 'bpc-157-tb-500');
  assert.equal(normalizeKey('  Tirzepatide 10 MG '), 'tirzepatide-10-mg');
  assert.equal(normalizeKey(null), '');
});

test('vialRelPath points at content/media/vials/<slug>.png', () => {
  assert.equal(vialRelPath('retatrutide'), 'content/media/vials/retatrutide.png');
});

test('every approved peptide appears in the product set with a vial path', () => {
  const all = products();
  const slugs = new Set(all.map((p) => p.slug));
  for (const p of PEPTIDE_CATALOG) {
    assert.ok(slugs.has(p.slug), `missing product ${p.slug}`);
  }
  for (const p of all) {
    assert.equal(p.file, `content/media/vials/${p.slug}.png`);
    assert.equal(typeof p.provided, 'boolean');
  }
});

test('resolveVial matches by display name, slug, and alias', () => {
  assert.equal(resolveVial('Retatrutide').slug, 'retatrutide');
  assert.equal(resolveVial('retatrutide').slug, 'retatrutide');
  assert.equal(resolveVial('CJC-1295 / Ipamorelin').slug, 'cjc-1295-ipamorelin');
  assert.equal(resolveVial('cjc 1295 ipamorelin').slug, 'cjc-1295-ipamorelin');
  assert.equal(resolveVial('BPC-157 / TB-500').slug, 'bpc-157-tb-500');
});

test('manifest extras (e.g. Tirzepatide) resolve, including custom aliases', () => {
  const t = resolveVial('Tirzepatide');
  assert.ok(t, 'Tirzepatide should resolve from the manifest');
  assert.equal(t.slug, 'tirzepatide');
  assert.equal(resolveVial('tirzepatide 10 mg').slug, 'tirzepatide');
});

test('resolveVial returns null for an unknown product and empty input', () => {
  assert.equal(resolveVial('definitely-not-a-real-peptide-xyz'), null);
  assert.equal(resolveVial(''), null);
  assert.equal(resolveVial(null), null);
});

test('two different products never resolve to the same slug (no cross-mapping)', () => {
  // The wrong-vial bug was a SELANK vial on a CJC post. Guard it explicitly.
  assert.notEqual(resolveVial('Selank').slug, resolveVial('CJC-1295 / Ipamorelin').slug);
  assert.equal(resolveVial('Selank').slug, 'selank');
});

test('coverage reports totals and lists every product', () => {
  const c = coverage();
  assert.equal(c.total, products().length);
  assert.ok(c.total >= PEPTIDE_CATALOG.length);
  assert.equal(c.provided + c.missing.length, c.total);
  assert.equal(c.products.length, c.total);
});

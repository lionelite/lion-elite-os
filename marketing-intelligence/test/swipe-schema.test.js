'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEntry, blankEntry, isWinner } = require('../src/swipe-schema');
const { load } = require('../src/swipe-database');

test('blankEntry starts honest: nulls and unknown format, not invented values', () => {
  const e = blankEntry();
  assert.equal(e.creative.format, 'unknown');
  assert.equal(e.creative.headline, null);
  assert.equal(e.performance.verificationStatus, 'unverified');
  assert.deepEqual(e.performance.metrics, []);
});

test('validateEntry requires id, brand, industry', () => {
  const { valid, errors } = validateEntry({});
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('id')));
  assert.ok(errors.some((e) => e.includes('brand')));
  assert.ok(errors.some((e) => e.includes('industry')));
});

test('validateEntry rejects a bad creative format and bad verification status', () => {
  const e = blankEntry({ id: 'x', brand: 'X', industry: 'y', creative: { format: 'meme' }, performance: { metrics: [], verificationStatus: 'trust-me' } });
  const { valid, errors } = validateEntry(e);
  assert.equal(valid, false);
  assert.ok(errors.some((s) => s.includes('creative.format')));
  assert.ok(errors.some((s) => s.includes('verificationStatus')));
});

test('validateEntry warns (not errors) on unresearched creative + missing hypothesis', () => {
  const e = blankEntry({ id: 'x', brand: 'X', industry: 'y' });
  const { valid, warnings } = validateEntry(e);
  assert.equal(valid, true);
  assert.ok(warnings.some((w) => w.includes('unresearched creative')));
  assert.ok(warnings.some((w) => w.includes('hypothesis')));
});

test('metrics with a source but no source.name warn as unverified', () => {
  const e = blankEntry({ id: 'x', brand: 'X', industry: 'y', source: { name: '', url: null },
    performance: { metrics: [{ name: 'cvr', value: 10, direction: 'increase' }], verificationStatus: 'reported-by-source' } });
  const { warnings } = validateEntry(e);
  assert.ok(warnings.some((w) => w.includes('no source.name')));
});

test('isWinner needs a positive metric AND a source', () => {
  const sourced = blankEntry({ id: 'a', brand: 'A', industry: 'z', source: { name: 'Replo' },
    performance: { metrics: [{ name: 'cvr', value: 67, direction: 'increase' }] } });
  const unsourced = blankEntry({ id: 'b', brand: 'B', industry: 'z',
    performance: { metrics: [{ name: 'cvr', value: 67, direction: 'increase' }] } });
  assert.equal(isWinner(sourced), true);
  assert.equal(isWinner(unsourced), false);
});

test('the seeded database loads clean with every row valid', () => {
  const { entries, invalid, winners } = load();
  assert.equal(invalid.length, 0, `invalid rows: ${JSON.stringify(invalid)}`);
  assert.ok(entries.length >= 7);
  assert.ok(winners.length >= 7, 'all seeded case studies should count as winners');
});

test('every seeded winner carries a source and marks research gaps (no fabrication)', () => {
  const { winners } = load();
  for (const w of winners) {
    assert.ok(w.source && w.source.name, `${w.id} must cite a source`);
    assert.equal(w.performance.verificationStatus, 'reported-by-source');
    assert.ok(w.research && Array.isArray(w.research.gaps) && w.research.gaps.length > 0,
      `${w.id} must list what we haven't verified`);
    // Unknown creative specifics must be null, never guessed.
    if (!w.creative.headline) assert.equal(w.creative.headline, null);
  }
});

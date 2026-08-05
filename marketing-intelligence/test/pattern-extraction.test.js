'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPatterns, proposeCandidates, priceBand } = require('../src/pattern-extraction');
const { load } = require('../src/swipe-database');

function winner(id, tags, extra = {}) {
  return {
    id, brand: id, industry: 'test', tags,
    creative: { format: 'unknown' },
    funnel: {},
    source: { name: 'src' },
    performance: { metrics: [{ name: 'cvr', value: 50, direction: 'increase' }] },
    ...extra
  };
}

test('priceBand buckets by amount or AOV, null when unknown', () => {
  assert.equal(priceBand({ amount: 19 }), '<$25');
  assert.equal(priceBand({ aov: 75 }), '$50–99');
  assert.equal(priceBand({ amount: 250 }), '$200+');
  assert.equal(priceBand(null), null);
  assert.equal(priceBand({}), null);
});

test('extractPatterns surfaces shared levers above minSupport', () => {
  const winners = [
    winner('a', ['landing-page-testing', 'cro']),
    winner('b', ['landing-page-testing']),
    winner('c', ['retargeting'])
  ];
  const p = extractPatterns(winners, { minSupport: 2 });
  assert.equal(p.sampleSize, 3);
  assert.ok(p.levers.some((l) => l.value === 'landing-page-testing' && l.support === 2));
  assert.ok(!p.levers.some((l) => l.value === 'cro'), 'cro has support 1, below minSupport');
});

test('extractPatterns counts ad+landing-system congruence', () => {
  const winners = [
    winner('a', ['x'], { funnel: { adLandingCongruence: 'yes' } }),
    winner('b', ['x'], { funnel: { adLandingCongruence: 'yes' } }),
    winner('c', ['x'], { funnel: {} })
  ];
  const p = extractPatterns(winners);
  assert.equal(p.adLandingSystem.support, 2);
  assert.deepEqual(p.adLandingSystem.brands, ['a', 'b']);
});

test('extractPatterns flags low sample size', () => {
  const p = extractPatterns([winner('a', ['x'])]);
  assert.equal(p.lowSample, true);
});

test('proposeCandidates produces auditable, evidence-backed candidates', () => {
  const winners = [
    winner('a', ['landing-page-testing']),
    winner('b', ['landing-page-testing'])
  ];
  const p = extractPatterns(winners, { minSupport: 2 });
  const candidates = proposeCandidates(p, winners);
  const lever = candidates.find((c) => c.patternId === 'lever:landing-page-testing');
  assert.ok(lever);
  assert.equal(lever.status, 'candidate');
  assert.deepEqual(lever.evidence.sort(), ['a', 'b']);
});

test('real seed: landing-page-testing and attribution emerge as shared levers', () => {
  const { winners } = load();
  const p = extractPatterns(winners, { minSupport: 2 });
  const leverValues = p.allLevers.map((l) => l.value);
  assert.ok(leverValues.includes('landing-page-testing'));
  assert.ok(leverValues.includes('attribution'));
  // The user's early thesis — ad + landing page as one system — should show up.
  assert.ok(p.adLandingSystem.support >= 1);
});

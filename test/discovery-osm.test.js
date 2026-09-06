'use strict';

// Business discovery.
//
// The discovery cron has enqueued 'scheduled-business-discovery' every four
// hours since it was written, and nothing consumed the queue. These cover the
// consumer, and in particular what it must refuse to collect: this finds
// BUSINESSES from their own public listings, never private individuals.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildQuery, parseBusinesses, fetchBusinesses, CATEGORIES } = require('../lib/discovery/osm-source');
const { runDiscovery, pickArea, DEFAULT_AREAS } = require('../lib/discovery/discovery-run');

const area = { south: 39.9, west: -83.1, north: 40.0, east: -82.9 };

test('the query targets the campaign segments and stays inside the bounding box', () => {
  const query = buildQuery({ area, categories: ['med-spa', 'gym'] });
  assert.ok(query.includes('[out:json]'));
  assert.ok(query.includes('["shop"="beauty"]'));
  assert.ok(query.includes('["leisure"="fitness_centre"]'));
  assert.ok(!query.includes('["healthcare"="physiotherapist"]'), 'only requested categories');
  assert.ok(query.includes('(39.9,-83.1,40,-82.9)'));
});

test('a runaway or inverted bounding box is refused', () => {
  // A huge box times Overpass out and gets the client rate limited.
  assert.throws(() => buildQuery({ area: { south: 0, west: 0, north: 40, east: 40 } }), /too large/);
  assert.throws(() => buildQuery({ area: { south: 40, west: 0, north: 39, east: 1 } }), /inverted/);
  assert.throws(() => buildQuery({ area: { south: 'x', west: 0, north: 1, east: 1 } }), /must be a number/);
});

test('an unknown category is refused rather than silently widened', () => {
  assert.throws(() => buildQuery({ area, categories: ['everything'] }), /No known categories/);
  assert.ok(Object.keys(CATEGORIES).length >= 5);
});

test('listings with nothing to act on are dropped', () => {
  const parsed = parseBusinesses({ elements: [
    { type: 'node', id: 1, tags: { name: 'Glow Med Spa', shop: 'beauty', 'contact:phone': '+16145550100' } },
    { type: 'node', id: 2, tags: { name: 'No Contact', shop: 'beauty' } },          // nothing to reach
    { type: 'node', id: 3, tags: { shop: 'beauty', phone: '+16145550101' } },        // no name
    { type: 'node', id: 1, tags: { name: 'Glow Med Spa', shop: 'beauty', phone: 'x' } } // same element
  ]});
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'Glow Med Spa');
  assert.equal(parsed[0].category, 'med-spa');
});

test('only a business’s own published contact details are read', () => {
  const [business] = parseBusinesses({ elements: [
    { type: 'node', id: 1, tags: {
      name: 'Renew Aesthetics', amenity: 'clinic',
      'contact:phone': '+16145550122', 'contact:email': 'hello@renew.example', website: 'https://renew.example',
      'addr:housenumber': '10', 'addr:street': 'High St', 'addr:city': 'Columbus',
      // Tags that name a person are deliberately not mapped to anything.
      'contact:person': 'Jane Doe', operator__individual: 'Jane Doe'
    } }
  ]});
  assert.equal(business.email, 'hello@renew.example');
  assert.equal(business.address, '10 High St Columbus');
  assert.deepEqual(
    Object.keys(business).filter(k => /person|individual|owner|first|last/i.test(k)),
    [],
    'no field may carry an individual’s identity'
  );
});

test('rate limiting is surfaced as retryable rather than swallowed', async () => {
  await assert.rejects(
    () => fetchBusinesses({ area, fetchImpl: async () => ({ ok: false, status: 429 }) }),
    error => error.retryable === true && /rate limiting/.test(error.message)
  );
  await assert.rejects(
    () => fetchBusinesses({ area, fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /Overpass responded 500/
  );
});

test('the request identifies itself to a donated shared service', async () => {
  let seen = null;
  await fetchBusinesses({
    area,
    fetchImpl: async (_url, options) => { seen = options; return { ok: true, status: 200, json: async () => ({ elements: [] }) }; }
  });
  assert.match(seen.headers['user-agent'], /LionEliteOS/);
  assert.equal(seen.method, 'POST');
});

test('a run enriches, stores, and reports what it did', async () => {
  const saved = [];
  const summary = await runDiscovery({
    rotation: 0, batchSize: 10, enrichDelayMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ elements: [
      { type: 'node', id: 1, tags: { name: 'Glow', shop: 'beauty', phone: '+16145550100', website: 'https://glow.example' } },
      { type: 'node', id: 2, tags: { name: 'Iron Gym', leisure: 'fitness_centre', phone: '+16145550111' } }
    ] }) }),
    enrichEmail: async b => (b.website ? { email: 'info@glow.example' } : {}),
    saveProspect: async input => { saved.push(input); return { duplicate: false }; },
    logger: { log() {} }
  });
  assert.equal(summary.found, 2);
  assert.equal(summary.stored, 2);
  assert.equal(summary.enriched, 1);
  assert.equal(saved[0].contact.email, 'info@glow.example');
  assert.equal(saved[0].campaignId, 'osm-business-discovery');
  // Nothing with a website is skipped in favour of one without.
  assert.equal(saved[0].business.name, 'Glow');
});

test('an enrichment failure does not lose the business', async () => {
  const saved = [];
  const summary = await runDiscovery({
    rotation: 0, batchSize: 5, enrichDelayMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ elements: [
      { type: 'node', id: 1, tags: { name: 'Glow', shop: 'beauty', phone: '+16145550100', website: 'https://glow.example' } }
    ] }) }),
    enrichEmail: async () => { throw new Error('site unreachable'); },
    saveProspect: async input => { saved.push(input); return { duplicate: false }; },
    logger: { log() {} }
  });
  assert.equal(summary.stored, 1, 'the phone and name are still worth having');
  assert.equal(saved[0].contact.email, null);
  assert.equal(summary.errors[0].stage, 'enrich');
});

test('successive runs rotate areas instead of re-walking one city', () => {
  const labels = [0, 1, 2, 3].map(i => pickArea(DEFAULT_AREAS, i).label);
  assert.equal(new Set(labels.slice(0, 3)).size, 3);
  assert.equal(labels[3], labels[0], 'and wrap around');
});

'use strict';

// Nominatim fallback discovery source: parsing, bounded search, spacing,
// failure reporting.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchBusinessesNominatim, toBusiness, SEARCH_TERMS } = require('../lib/discovery/nominatim-source');

const area = { label: 'miami-fl', south: 25.7, west: -80.32, north: 25.95, east: -80.12 };

test('toBusiness keeps listings with a website or phone, reads contact tags', () => {
  const b = toBusiness({ osm_type: 'node', osm_id: 5, name: 'Glow Med Spa', category: 'shop', type: 'beauty',
    extratags: { website: 'https://glow.example', 'contact:email': 'info@glow.example', phone: '+1 305 555 0100' },
    address: { house_number: '1', road: 'Main St', city: 'Miami', state: 'Florida', postcode: '33101' } }, 'med spa');
  assert.equal(b.name, 'Glow Med Spa');
  assert.equal(b.website, 'https://glow.example');
  assert.equal(b.email, 'info@glow.example');
  assert.equal(b.category, 'med-spa');
  assert.equal(b.sourceRef, 'node/5');
  assert.equal(b.address, '1 Main St, Miami, Florida, 33101');
  assert.equal(toBusiness({ osm_type: 'node', osm_id: 6, name: 'No Contact', extratags: {} }, 'x'), null);
  assert.equal(toBusiness({ osm_type: 'node', osm_id: 7, category: 'amenity', type: 'clinic', name: 'Vital Clinic', extratags: { phone: '1' } }, 'hormone').category, 'clinic');
});

test('bounded US search per term, 1 req/s, deduped, identified', async () => {
  const urls = []; const sleeps = [];
  const result = await fetchBusinessesNominatim({
    area, sleepImpl: async ms => sleeps.push(ms),
    fetchImpl: async (url, opts) => {
      urls.push(url);
      assert.match(opts.headers['user-agent'], /LionEliteOS/);
      return { ok: true, status: 200, json: async () => [{ osm_type: 'way', osm_id: 1, name: 'Same Clinic', extratags: { website: 'https://same.example' } }] };
    },
  });
  assert.equal(urls.length, SEARCH_TERMS.length);
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get('bounded'), '1');
  assert.equal(q.get('countrycodes'), 'us');
  assert.equal(q.get('viewbox'), '-80.32,25.95,-80.12,25.7');
  assert.equal(result.businesses.length, 1, 'same OSM object from several searches kept once');
  assert.equal(result.source, 'openstreetmap-nominatim');
  assert.deepEqual(sleeps, Array(SEARCH_TERMS.length - 1).fill(1100));
});

test('reports partial failures; throws only when every search failed', async () => {
  let n = 0;
  const partial = await fetchBusinessesNominatim({ area, sleepImpl: async () => {}, logger: {},
    fetchImpl: async () => (++n % 2 ? { ok: false, status: 503, json: async () => [] } : { ok: true, status: 200, json: async () => [] }) });
  assert.equal(partial.failures.length, Math.ceil(SEARCH_TERMS.length / 2));
  await assert.rejects(fetchBusinessesNominatim({ area, sleepImpl: async () => {}, logger: {}, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /Nominatim unreachable/);
});

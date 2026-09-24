'use strict';

// Business discovery.
//
// The discovery cron has enqueued 'scheduled-business-discovery' every four
// hours since it was written, and nothing consumed the queue. These cover the
// consumer, and in particular what it must refuse to collect: this finds
// BUSINESSES from their own public listings, never private individuals.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildQuery, parseBusinesses, fetchBusinesses, fetchBusinessesByCategory, CATEGORIES, DEFAULT_TIMEOUT_MS } = require('../lib/discovery/osm-source');
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
  // Pinning `endpoint` disables failover, so this still tests the single-request
  // behaviour it was written for rather than silently exercising three mirrors.
  await assert.rejects(
    () => fetchBusinesses({ area, endpoint: 'https://one.test/api', fetchImpl: async () => ({ ok: false, status: 429 }) }),
    error => error.retryable === true && /rate limiting/.test(error.message)
  );
  await assert.rejects(
    () => fetchBusinesses({ area, endpoint: 'https://one.test/api', fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /Overpass responded 500/
  );
});

test('a busy mirror is retried on the next one', async () => {
  const tried = [];
  const businesses = await fetchBusinesses({
    area,
    endpoints: ['https://busy.test/api', 'https://spare.test/api'],
    sleepImpl: async () => {},
    logger: { warn() {} },
    fetchImpl: async (url) => {
      tried.push(url);
      // The live failure: overpass-api.de answers a large bbox with 504.
      if (url === 'https://busy.test/api') return { ok: false, status: 504 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          elements: [{
            type: 'node', id: 7, lat: 1, lon: 2,
            tags: { name: 'Spare Spa', shop: 'beauty', 'contact:phone': '+1-614-555-0100' }
          }]
        })
      };
    }
  });

  assert.deepStrictEqual(tried, ['https://busy.test/api', 'https://spare.test/api']);
  assert.strictEqual(businesses.length, 1);
  assert.strictEqual(businesses[0].name, 'Spare Spa');
});

test('a timeout also moves to the next mirror', async () => {
  const tried = [];
  const businesses = await fetchBusinesses({
    area,
    endpoints: ['https://slow.test/api', 'https://spare.test/api'],
    sleepImpl: async () => {},
    logger: { warn() {} },
    fetchImpl: async (url) => {
      tried.push(url);
      if (url === 'https://slow.test/api') {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      return { ok: true, status: 200, json: async () => ({ elements: [] }) };
    }
  });

  assert.strictEqual(tried.length, 2);
  assert.deepStrictEqual(businesses, []);
});

test('a bad query fails fast instead of hammering every mirror', async () => {
  const tried = [];
  await assert.rejects(
    () => fetchBusinesses({
      area,
      endpoints: ['https://a.test/api', 'https://b.test/api', 'https://c.test/api'],
      sleepImpl: async () => {},
      logger: { warn() {} },
      fetchImpl: async (url) => { tried.push(url); return { ok: false, status: 400 }; }
    }),
    /Overpass responded 400/
  );
  assert.strictEqual(tried.length, 1, 'every mirror would reject a malformed query identically');
});

test('when every mirror is busy the last failure is what surfaces', async () => {
  const tried = [];
  await assert.rejects(
    () => fetchBusinesses({
      area,
      endpoints: ['https://a.test/api', 'https://b.test/api'],
      sleepImpl: async () => {},
      logger: { warn() {} },
      fetchImpl: async (url) => { tried.push(url); return { ok: false, status: 504 }; }
    }),
    error => error.retryable === true
  );
  assert.strictEqual(tried.length, 2, 'both mirrors are attempted before giving up');
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
  // Written against the length of the list rather than the behaviour, so adding
  // a market broke it. The property is what matters: one full cycle visits every
  // area exactly once, then wraps.
  const cycle = DEFAULT_AREAS.map((_, i) => pickArea(DEFAULT_AREAS, i).label);

  assert.equal(new Set(cycle).size, DEFAULT_AREAS.length, 'no area is skipped in a cycle');
  assert.equal(pickArea(DEFAULT_AREAS, DEFAULT_AREAS.length).label, cycle[0], 'and wrap around');
});

// The scheduled harvest reported "0 new" on every run for weeks. Both sources
// were failing: Bluesky 403s a datacenter IP, and Overpass never answered a
// single 18-member union query over a 2-degree box. These cover the Overpass
// half — the part fixable without a credential.

test('one union member per selector, not a node and a way each', () => {
  const query = buildQuery({ area });
  const members = query.split('\n').filter(line => line.trim().endsWith(';') && line.startsWith('  '));
  const selectors = Object.values(CATEGORIES).flat().length;

  assert.equal(members.length, selectors, 'nwr collapses the node/way pair into one member');
  assert.ok(!/^\s*node\[/m.test(query), 'no separate node clause');
  assert.ok(!/^\s*way\[/m.test(query), 'no separate way clause');
  assert.ok(/^\s*nwr\[/m.test(query));
});

test('the server gives up before the client does', async () => {
  // A 60s server budget under a 90s client wait meant a saturated mirror cost
  // the full 90s and returned nothing to act on. The server must fail first so
  // failover is driven by a real 504.
  let sent = null;
  await fetchBusinesses({
    area,
    endpoint: 'https://one.test/api',
    timeoutMs: 45000,
    fetchImpl: async (_url, options) => { sent = options.body; return { ok: true, status: 200, json: async () => ({ elements: [] }) }; }
  });

  const budget = Number(decodeURIComponent(sent).match(/\[timeout:(\d+)\]/)[1]);
  assert.ok(budget * 1000 < 45000, `server budget ${budget}s must sit inside the 45s client wait`);
  assert.ok(budget >= 10, 'but still long enough to answer a small query');
});

test('one unreachable segment no longer takes the whole run down', async () => {
  // This is the bug: a single union meant all-or-nothing, so one heavy segment
  // reported the entire area as empty.
  const asked = [];
  const { businesses, failures } = await fetchBusinessesByCategory({
    area,
    categories: ['med-spa', 'gym'],
    endpoint: 'https://one.test/api',
    sleepImpl: async () => {},
    logger: { warn() {} },
    fetchImpl: async (_url, options) => {
      const query = decodeURIComponent(options.body);
      asked.push(query);
      if (query.includes('fitness_centre')) {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ elements: [{
          type: 'node', id: 11, lat: 1, lon: 2,
          tags: { name: 'Still Found Spa', shop: 'beauty', 'contact:phone': '+16145550100' }
        }] })
      };
    }
  });

  assert.equal(asked.length, 2, 'each category is its own request');
  assert.equal(businesses.length, 1, 'the reachable segment still produces leads');
  assert.equal(businesses[0].name, 'Still Found Spa');
  assert.deepStrictEqual(failures.map(f => f.category), ['gym'], 'and the loss is reported, not swallowed');
});

test('the same listing found under two segments is stored once', async () => {
  const { businesses } = await fetchBusinessesByCategory({
    area,
    categories: ['med-spa', 'massage'],
    endpoint: 'https://one.test/api',
    sleepImpl: async () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ elements: [{
        type: 'node', id: 42, lat: 1, lon: 2,
        tags: { name: 'Overlap Spa', shop: 'beauty', 'contact:phone': '+16145550100' }
      }] })
    })
  });

  assert.equal(businesses.length, 1);
});

test('every segment failing is an unreachable source, not an empty area', async () => {
  // "found 0" has to keep meaning "there was nothing there". If a total outage
  // returned an empty list, a dead pipeline would report a quiet day forever —
  // which is exactly how this went unnoticed.
  await assert.rejects(
    () => fetchBusinessesByCategory({
      area,
      categories: ['med-spa', 'gym'],
      endpoint: 'https://one.test/api',
      sleepImpl: async () => {},
      logger: { warn() {} },
      fetchImpl: async () => ({ ok: false, status: 504 })
    }),
    error => error.retryable === true
  );
});

test('every search area is a box Overpass will actually answer', () => {
  // A bad box does not fail loudly — buildQuery throws deep inside a harvest
  // run, the business pass reports "unreachable", and the digest shows another
  // quiet day. Check them here instead, where the failure names the area.
  const labels = new Set();
  for (const area of DEFAULT_AREAS) {
    assert.ok(area.label, 'every area is named; the digest reports the label');
    assert.ok(!labels.has(area.label), `duplicate area label ${area.label}`);
    labels.add(area.label);

    assert.doesNotThrow(() => buildQuery({ area }), `${area.label} is not a queryable box`);
    assert.ok(area.north - area.south <= 0.5, `${area.label} is taller than a metro core`);
    assert.ok(area.east - area.west <= 0.5, `${area.label} is wider than a metro core`);
  }
});

test('rotation reaches every area rather than re-walking one', () => {
  // The harvest passes the UTC hour as the rotation, so the cycle has to close
  // over a day. Three Ohio areas got fully harvested and then returned nothing
  // new for weeks; an area the rotation never reaches is the same bug, quieter.
  const reached = new Set();
  for (let hour = 0; hour < 24; hour += 1) reached.add(pickArea(DEFAULT_AREAS, hour).label);

  assert.equal(reached.size, DEFAULT_AREAS.length, 'a day of runs covers every area');
});

test('the markets the campaigns target are actually searched', () => {
  // The med-spa supply campaign and the campaign-builder examples both target
  // South Florida. Searching only Ohio is why a working source found nothing
  // new, so this pins the intent rather than leaving it to a comment.
  const labels = DEFAULT_AREAS.map(a => a.label);
  assert.ok(labels.some(l => l.endsWith('-fl')), 'at least one Florida market');
  assert.ok(labels.includes('miami-fl'), 'South Florida is the named target market');
});

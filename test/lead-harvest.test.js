'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { harvestBluesky, searchPosts, postUrl, rkeyFromUri, SEARCH_QUERIES } = require('../lib/leads/harvest');

// Shaped like a real app.bsky.feed.searchPosts response.
function post({ did, handle, displayName, text, uri, createdAt = '2026-09-06T12:00:00.000Z' }) {
  return {
    uri: uri || `at://${did}/app.bsky.feed.post/3abcxyz`,
    cid: 'bafyfake',
    author: { did, handle, displayName },
    record: { text, createdAt, $type: 'app.bsky.feed.post' },
    indexedAt: createdAt
  };
}

function fakeFetch(postsByQuery) {
  return async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    return {
      ok: true,
      status: 200,
      json: async () => ({ posts: postsByQuery[q] || [] })
    };
  };
}

test('rkey and post URL are built from the at:// uri', () => {
  assert.strictEqual(rkeyFromUri('at://did:plc:abc/app.bsky.feed.post/3lxyz'), '3lxyz');
  assert.strictEqual(
    postUrl({ uri: 'at://did:plc:abc/app.bsky.feed.post/3lxyz', author: { handle: 'coach.bsky.social' } }),
    'https://bsky.app/profile/coach.bsky.social/post/3lxyz'
  );
});

test('a qualifying coach post becomes a lead with its evidence attached', async () => {
  const query = 'looking for a coaching platform';
  const fetchImpl = fakeFetch({
    [query]: [
      post({
        did: 'did:plc:coach1',
        handle: 'newcoach.bsky.social',
        displayName: 'Jamie R.',
        text: 'Just got certified and I need a coaching platform — what platform do you use to manage clients? Drowning in spreadsheets.'
      })
    ]
  });

  const { leads, summary } = await harvestBluesky({
    audiences: ['coach-scaling'],
    queries: { 'coach-scaling': [query] },
    fetchImpl,
    delayMs: 0
  });

  assert.strictEqual(summary.matched, 1);
  assert.strictEqual(leads.length, 1);

  const lead = leads[0];
  assert.strictEqual(lead.name, 'Jamie R.');
  assert.strictEqual(lead.handle, 'newcoach.bsky.social');
  assert.strictEqual(lead.audience, 'coach-scaling');
  assert.strictEqual(lead.brand, 'lionos');
  assert.strictEqual(lead.profileUrl, 'https://bsky.app/profile/newcoach.bsky.social');
  assert.ok(lead.postUrl.startsWith('https://bsky.app/profile/newcoach.bsky.social/post/'));
  assert.ok(lead.score >= 40, 'a real match scores at least the base 40');
  // The evidence is what makes the lead reviewable rather than asserted.
  assert.ok(lead.matchedTerms.subject.length > 0);
  assert.ok(lead.matchedTerms.intent.length > 0);
});

test('a post found by search but failing the classifier is not stored', async () => {
  const query = 'looking for a coaching platform';
  const fetchImpl = fakeFetch({
    [query]: [
      post({
        did: 'did:plc:noise',
        handle: 'noise.bsky.social',
        displayName: 'Noise',
        // Mentions a platform, states no need — no intent term for this audience.
        text: 'The weather platform on this app is surprisingly good.'
      })
    ]
  });

  const { leads, summary } = await harvestBluesky({
    audiences: ['coach-scaling'],
    queries: { 'coach-scaling': [query] },
    fetchImpl,
    delayMs: 0
  });

  assert.strictEqual(leads.length, 0);
  assert.strictEqual(summary.postsSeen, 1, 'the post was read');
  assert.strictEqual(summary.matched, 0, 'and rejected');
});

test('a do-not-engage post is dropped, not stored for someone to find later', async () => {
  const query = 'peptide vendor recommendations';
  const fetchImpl = fakeFetch({
    [query]: [
      post({
        did: 'did:plc:humanuse',
        handle: 'person.bsky.social',
        displayName: 'Person',
        // Human-use intent: RUO compliance forbids engaging this.
        text: 'Looking for a reputable peptide supplier — where to get BPC-157 for my own injury, what dose should I inject?'
      })
    ]
  });

  const { leads, summary } = await harvestBluesky({
    audiences: ['research-peptides'],
    queries: { 'research-peptides': [query] },
    fetchImpl,
    delayMs: 0
  });

  assert.strictEqual(leads.length, 0, 'human-use intent never becomes a lead');
  assert.strictEqual(summary.skippedDoNotEngage, 1);
});

test('the same post found by two queries is stored once', async () => {
  const text = 'Just got certified and I need a coaching platform to manage my clients.';
  const uri = 'at://did:plc:dupe/app.bsky.feed.post/3same';
  const p = post({ did: 'did:plc:dupe', handle: 'dupe.bsky.social', displayName: 'Dupe', text, uri });
  const fetchImpl = fakeFetch({ 'query one': [p], 'query two': [p] });

  const { leads, summary } = await harvestBluesky({
    audiences: ['coach-scaling'],
    queries: { 'coach-scaling': ['query one', 'query two'] },
    fetchImpl,
    delayMs: 0
  });

  assert.strictEqual(leads.length, 1);
  assert.strictEqual(summary.duplicates, 1);
});

test('a failing search degrades the run instead of killing it', async () => {
  const good = post({
    did: 'did:plc:ok',
    handle: 'ok.bsky.social',
    displayName: 'OK',
    text: 'Just got certified, looking for a coaching platform for my clients.'
  });
  const fetchImpl = async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    if (q === 'boom') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ posts: [good] }) };
  };

  const { leads, summary } = await harvestBluesky({
    audiences: ['coach-scaling'],
    queries: { 'coach-scaling': ['boom', 'fine'] },
    fetchImpl,
    delayMs: 0,
    logger: { warn() {} }
  });

  assert.strictEqual(summary.errors.length, 1);
  assert.match(summary.errors[0], /HTTP 503/);
  assert.strictEqual(leads.length, 1, 'the surviving query still produced its lead');
});

test('the search request carries no credential', async () => {
  let seenHeaders = null;
  let seenUrl = null;
  const fetchImpl = async (url, options) => {
    seenUrl = url;
    seenHeaders = options?.headers || {};
    return { ok: true, status: 200, json: async () => ({ posts: [] }) };
  };

  await searchPosts({ query: 'anything', fetchImpl });

  const headerNames = Object.keys(seenHeaders).map((h) => h.toLowerCase());
  assert.ok(!headerNames.includes('authorization'), 'public search must stay unauthenticated');
  assert.ok(!headerNames.includes('cookie'));
  assert.ok(seenUrl.startsWith('https://public.api.bsky.app/'));
});

test('every audience with search queries is a real audience profile', () => {
  const { AUDIENCE_PROFILES } = require('../social-listening/src/audience-profiles');
  for (const key of Object.keys(SEARCH_QUERIES)) {
    assert.ok(AUDIENCE_PROFILES[key], `${key} must exist in audience-profiles.js`);
    assert.ok(SEARCH_QUERIES[key].length > 0, `${key} must have at least one query`);
  }
});

test('the harvester has no send path', () => {
  const fs = require('fs');
  const source = fs.readFileSync(require.resolve('../lib/leads/harvest.js'), 'utf8');
  // Deliberately not asserting on the string 'app.bsky.feed.post': that
  // record type appears in a comment explaining how an at:// URI is parsed,
  // which is a read. The invariant that actually matters is below — the
  // module never issues anything but an unauthenticated GET.
  for (const forbidden of ['createSession', 'sendReply', 'createRecord', 'app.bsky.graph.follow', 'app.bsky.feed.like']) {
    assert.ok(!source.includes(forbidden), `harvest.js must not reference ${forbidden}`);
  }
});

test('every request the harvester makes is an unauthenticated GET with no body', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ posts: [] }) };
  };

  await harvestBluesky({
    audiences: ['coach-scaling'],
    queries: { 'coach-scaling': ['one', 'two'] },
    fetchImpl,
    delayMs: 0
  });

  assert.strictEqual(calls.length, 2, 'both queries ran');
  for (const { url, options } of calls) {
    const method = (options.method || 'GET').toUpperCase();
    assert.strictEqual(method, 'GET', 'a write method would mean this module can post');
    assert.strictEqual(options.body, undefined, 'a GET carrying a body is a write in disguise');
    assert.ok(url.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts'),
      'the only endpoint reached is public search');
  }
});

// --- B2B pass: businesses with published phone/email -----------------------

const { harvestBusinesses } = require('../lib/leads/business-harvest');

function overpassResponse(elements) {
  return { ok: true, status: 200, json: async () => ({ elements }) };
}

const MEDSPA = {
  type: 'node',
  id: 111,
  lat: 39.96,
  lon: -83.0,
  tags: {
    name: 'Radiance Med Spa',
    shop: 'beauty',
    'contact:phone': '+1-614-555-0142',
    'contact:website': 'https://radiance-example.test',
    'addr:city': 'Columbus',
    'addr:state': 'OH'
  }
};

test('a business becomes a lead carrying phone and enriched email', async () => {
  const { leads, summary } = await harvestBusinesses({
    rotation: 0,
    batchSize: 5,
    fetchImpl: async () => overpassResponse([MEDSPA]),
    enrichImpl: async () => ({ status: 'verified', email: 'hello@radiance-example.test' }),
    enrichDelayMs: 0,
    logger: { log() {} }
  });

  assert.strictEqual(leads.length, 1);
  const lead = leads[0];
  assert.strictEqual(lead.source, 'openstreetmap');
  assert.strictEqual(lead.name, 'Radiance Med Spa');
  assert.strictEqual(lead.phone, '+1-614-555-0142');
  assert.strictEqual(lead.email, 'hello@radiance-example.test');
  assert.strictEqual(lead.contactChannel, 'email');
  assert.ok(lead.score > 0);
  assert.strictEqual(summary.enriched, 1);
});

test('an unverified enrichment yields a phone-only lead rather than a guessed email', async () => {
  const { leads } = await harvestBusinesses({
    fetchImpl: async () => overpassResponse([MEDSPA]),
    // The real module returns a blocked status when it cannot verify one.
    enrichImpl: async () => ({ status: 'blocked', reason: 'NO_VERIFIED_PUBLIC_BUSINESS_EMAIL', candidates: [] }),
    enrichDelayMs: 0,
    logger: { log() {} }
  });

  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].email, null, 'an unverified email is never stored');
  assert.strictEqual(leads[0].phone, '+1-614-555-0142');
  assert.strictEqual(leads[0].contactChannel, 'phone');
});

test('a business already harvested is skipped before its website is scraped again', async () => {
  let enrichCalls = 0;
  const { leads, summary } = await harvestBusinesses({
    knownIds: new Set(['osm:node/111']),
    fetchImpl: async () => overpassResponse([MEDSPA]),
    enrichImpl: async () => {
      enrichCalls += 1;
      return { status: 'verified', email: 'hello@radiance-example.test' };
    },
    enrichDelayMs: 0,
    logger: { log() {} }
  });

  assert.strictEqual(leads.length, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(enrichCalls, 0, 'a known business must not have its site re-scraped');
});

test('runDiscovery skips nothing unless a caller asks it to', async () => {
  const { runDiscovery } = require('../lib/discovery/discovery-run');
  const stored = [];
  const summary = await runDiscovery({
    rotation: 0,
    batchSize: 5,
    enrichDelayMs: 0,
    fetchImpl: async () => overpassResponse([MEDSPA]),
    enrichEmail: async () => null,
    saveProspect: async (record) => { stored.push(record); return { duplicate: false }; },
    logger: { log() {} }
  });

  assert.strictEqual(stored.length, 1, 'the default predicate skips nothing');
  assert.strictEqual(summary.skipped, 0);
});

// --- the digest must not claim a search happened when it did not ------------

test('a run where every search failed says so instead of "nothing matched"', async () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const fs = require('node:fs');
  const pathMod = require('node:path');

  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'harvest-'));
  const outFile = pathMod.join(dir, 'github_output');
  fs.writeFileSync(outFile, '');

  // Every search 403s, exactly as the public AppView does from a datacenter IP.
  const runner = pathMod.join(dir, 'run.js');
  fs.writeFileSync(runner, `
    global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    process.argv.push('--dry-run');
    require(${JSON.stringify(require.resolve('../scripts/harvest-leads.js'))});
  `);

  const out = execFileSync(process.execPath, [runner], { encoding: 'utf8', env: { ...process.env } });

  assert.match(out, /no source could be reached/i,
    'the digest must name the failure rather than imply an empty result');
  assert.doesNotMatch(out, /The searches ran; nothing cleared the classifier/,
    'that sentence is false when nothing was queried');
  assert.match(out, /searches failed/i, 'the failure count belongs in the digest');

  fs.rmSync(dir, { recursive: true, force: true });
});

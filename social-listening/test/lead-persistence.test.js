'use strict';

// Durability of Bluesky leads.
//
// Until this was wired up, only the "universal" lane reached Postgres. Brand
// classifier matches — the lanes carrying the two segments the business wants
// (people seeking a coach, coaches scaling their own business) — were appended
// to a JSONL file inside an ephemeral container and lost on every restart.
//
// The reader also filtered on a single campaign id, so audience leads were
// invisible even once stored. That writer/reader drift is the same class of
// bug as the audit_events mismatch, and CI has no Postgres to catch it the
// normal way, so it is pinned here by identity instead.

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../src/universal-lead-store');
const report = require('../../lib/bluesky-lead-report');

test('the lane that writes audience leads and the report that reads them agree', () => {
  assert.equal(
    store.AUDIENCE_CAMPAIGN_ID,
    report.AUDIENCE_CAMPAIGN_ID,
    'writer and reader must use the same campaign id or stored leads are invisible'
  );
  assert.ok(
    report.CAMPAIGN_IDS.includes(store.CAMPAIGN_ID),
    'the report must still cover the universal lane'
  );
  assert.ok(
    report.CAMPAIGN_IDS.includes(store.AUDIENCE_CAMPAIGN_ID),
    'the report must cover the audience lane'
  );
});

test('a do-not-engage match is never written to the prospects table', async () => {
  const saved = process.env.DATABASE_URL;
  // Set so a bug that ignored the guard would attempt a real connection and
  // fail loudly rather than silently returning the not-configured path.
  process.env.DATABASE_URL = 'postgres://unreachable.invalid:1/none';
  try {
    const result = await store.persistAudienceMatch(
      { did: 'did:plc:peer', rkey: 'r', url: 'https://bsky.app/p/r' },
      { audience: 'personal-training', score: 95, doNotEngage: true, matched: { intent: [], subject: [] } }
    );
    assert.equal(result.stored, false);
    assert.equal(result.reason, 'DO_NOT_ENGAGE');
  } finally {
    if (saved == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test('persistence is a no-op without a database rather than throwing', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const result = await store.persistAudienceMatch(
      { did: 'did:plc:x', rkey: 'r', url: 'https://bsky.app/p/r' },
      { audience: 'coach-scaling', score: 80, doNotEngage: false, matched: { intent: ['how do i'], subject: ['coaching business'] } }
    );
    assert.equal(result.stored, false);
    assert.equal(result.reason, 'DATABASE_URL_NOT_CONFIGURED');
  } finally {
    if (saved == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

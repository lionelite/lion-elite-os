'use strict';

// Discovery prefetch and circuit breakers, against a real Postgres:
//   - plan → upload → the run reads the uploaded metro from the day cache
//     and never touches the network for it;
//   - unknown metros are refused;
//   - when neither Overpass nor Nominatim answers, the run stops after one
//     metro, asks Nominatim once, and does not advance past the unsearched metro.
// Skips without DATABASE_URL (CI provisions Postgres).

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('discovery prefetch + circuit breakers', { skip: !databaseConfigured, timeout: 60_000 }, async t => {
  const database = require('../lib/database');
  const { holdExclusiveDb } = require('./helpers/db-exclusive');
  const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
  const { createClinicOutreachRunner } = require('../lib/outreach/clinic-outreach-run');
  const { DEFAULT_AREAS } = require('../lib/discovery/discovery-run');
  const { resetThrottle } = require('../lib/discovery/nominatim-source');
  const control = require('../lib/outreach/outreach-control');
  const { query } = database;

  const release = await holdExclusiveDb();
  const tag = Math.random().toString(36).slice(2, 8);
  const DAY = '2026-11-03';
  const NOW = new Date('2026-11-03T15:00:00Z');
  t.after(async () => {
    await query(`DELETE FROM prospects WHERE business->>'name' LIKE $1`, [`%${tag}%`]).catch(() => {});
    await query(`DELETE FROM discovery_area_cache WHERE run_date = $1`, [DAY]).catch(() => {});
    await query(`DELETE FROM discovery_site_checks WHERE domain LIKE $1`, [`%${tag}%`]).catch(() => {});
    await query(`DELETE FROM outreach_runs WHERE trigger LIKE 'prefetch-test%'`).catch(() => {});
    await query(`DELETE FROM app_settings WHERE key = $1`, [control.ROTATION_KEY]).catch(() => {});
    await release();
    await database.close();
  });
  await database.migrate();
  await control.ensureSchema(database);
  await query(`DELETE FROM discovery_area_cache WHERE run_date = $1`, [DAY]);
  await control.setSetting(database, control.ROTATION_KEY, 0, 'test');

  const store = new PostgresProspectStore();
  const quiet = { log() {}, warn() {}, error() {} };
  const networkCalls = [];
  const runner = (over = {}) => createClinicOutreachRunner({
    env: { OSM_CONTACT_EMAIL: 'ops@example.com', DISCOVERY_MAX_AREAS_PER_RUN: '1' }, store, now: () => NOW, logger: quiet,
    sleep: async () => {}, discoverySleep: async () => {}, nominatimSleep: async () => {}, enrichDelayMs: 0,
    discoveryFetch: async url => { networkCalls.push(String(url)); throw new TypeError('fetch failed'); },
    nominatimFetch: async url => { networkCalls.push(String(url)); return { ok: false, status: 429, json: async () => ({}) }; },
    enrichEmail: async b => (b.website.includes('withmail') ? { email: `info@${new URL(b.website).hostname}` } : null),
    mirror: async () => ({ status: 'skipped' }),
    ...over,
  });

  // Plan: next metros from rotation 0, with our User-Agent carrying the contact e-mail.
  const plan = await runner().discoveryPlan({ count: 2 });
  assert.equal(plan.date, DAY);
  assert.deepEqual(plan.areas.map(a => a.label), [DEFAULT_AREAS[0].label, DEFAULT_AREAS[1].label]);
  assert.match(plan.userAgent, /ops@example\.com/);

  // Upload: unknown metro refused; the known one cached and dropped from the next plan.
  const first = DEFAULT_AREAS[0].label;
  const up = await runner().storeAreaResults({ areas: [
    { label: 'not-a-metro', businesses: [] },
    { label: first, businesses: [
      { name: `Glow Longevity Clinic ${tag}`, website: `https://withmail-${tag}.example`, category: 'clinic', sourceRef: 'node/1' },
      { name: `Quiet Aesthetics ${tag}`, website: `https://nomail-${tag}.example`, category: 'med-spa', sourceRef: 'node/2' },
      { name: `No Site Spa ${tag}`, category: 'med-spa', sourceRef: 'node/3' },
    ] },
  ] });
  assert.deepEqual(up.rejected.map(r => r.label), ['not-a-metro']);
  assert.equal(up.stored[0].businesses, 2, 'listing without a website dropped');
  assert.deepEqual((await runner().discoveryPlan({ count: 1 })).areas.map(a => a.label), [DEFAULT_AREAS[1].label]);

  // Run: the cached metro is worked without any network call; the clinic with an
  // e-mail is stored, the one without is skipped and remembered.
  resetThrottle();
  const dry = await runner().run({ dryRun: true, trigger: 'prefetch-test' });
  assert.equal(dry.status, 'completed', JSON.stringify(dry.error || dry.notes));
  assert.deepEqual(dry.discovery.cachedAreas, [first]);
  assert.equal(dry.discovery.stored, 1);
  assert.equal(dry.discovery.skippedNoEmail, 1);
  assert.equal(networkCalls.length, 0, 'no map request for a cached metro');
  assert.ok((await query(`SELECT 1 FROM discovery_site_checks WHERE domain = $1 AND email_found = false`, [`nomail-${tag}.example`])).rowCount);

  // Circuit breaker: next metro is uncached, Overpass refuses, Nominatim 429s.
  // The run asks Nominatim ONCE, stops, and leaves rotation on the unsearched metro.
  const rotationBefore = Number(await control.getSetting(database, control.ROTATION_KEY, 0));
  const blocked = await runner({ env: { OSM_CONTACT_EMAIL: 'ops@example.com', DISCOVERY_MAX_AREAS_PER_RUN: '6' } })
    .run({ dryRun: true, trigger: 'prefetch-test-blocked' });
  assert.equal(blocked.status, 'completed');
  assert.match(blocked.discovery.stoppedEarly, /no map service reachable/);
  assert.ok(blocked.discovery.nominatimBlocked);
  assert.equal(networkCalls.filter(u => u.includes('nominatim')).length, 1, 'one Nominatim request, then stop');
  assert.equal(Number(await control.getSetting(database, control.ROTATION_KEY, 0)), rotationBefore, 'unsearched metro not skipped');
});

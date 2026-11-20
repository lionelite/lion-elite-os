'use strict';

// The service half of clinic discovery against a real Postgres, through the
// HTTP routes the runner calls: state → known → store → log. Checks that new
// clinics land as lion-elite-clinical prospects with provenance, and that
// webmail, off-domain addresses, low-tier clinics and anything already on
// record (any campaign, by domain or e-mail) are refused.
// Skips without DATABASE_URL (CI provisions Postgres).

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('clinic discovery store + routes', { skip: !databaseConfigured, timeout: 60_000 }, async t => {
  const express = require('express');
  const database = require('../lib/database');
  const { holdExclusiveDb } = require('./helpers/db-exclusive');
  const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
  const { createOutreachRunRouter } = require('../routes/outreach-run');
  const { createClinicDiscoveryStore, CAMPAIGN_ID, CURSOR_KEY } = require('../lib/discovery/clinic-discovery-store');
  const { DEFAULT_AREAS } = require('../lib/discovery/discovery-run');
  const control = require('../lib/outreach/outreach-control');
  const { query } = database;

  const release = await holdExclusiveDb();
  const tag = Math.random().toString(36).slice(2, 8);
  const host = l => `${l}-${tag}.example`;
  const store = new PostgresProspectStore();
  let server;
  t.after(async () => {
    server?.close();
    await query(`DELETE FROM prospects WHERE business->>'name' LIKE $1`, [`%${tag}%`]).catch(() => {});
    await query(`DELETE FROM discovery_site_checks WHERE domain LIKE $1`, [`%${tag}%`]).catch(() => {});
    await query(`DELETE FROM clinic_discovery_runs WHERE trigger = 'secret'`).catch(() => {});
    await query(`DELETE FROM app_settings WHERE key = $1`, [CURSOR_KEY]).catch(() => {});
    await release();
    await database.close();
  });
  await database.migrate();
  await query(`DELETE FROM app_settings WHERE key = $1`, [CURSOR_KEY]).catch(() => {});

  // An existing prospect in another campaign, known by website domain.
  await store.create({ business: { name: `Old Record ${tag}`, website: `https://${host('old')}` }, contact: { email: null }, campaignId: 'osm-business-discovery' }, 'test');

  const env = { OUTREACH_SECRET: 'test-secret', CLINIC_DISCOVERY_DAILY_TARGET: '200', OSM_CONTACT_EMAIL: 'ops@example.com' };
  const discoveryStore = createClinicDiscoveryStore({ env, store, logger: { log() {} } });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(createOutreachRunRouter({ env, discoveryStore, runner: {}, logger: { warn() {}, error() {}, log() {} } }));
  server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, headers = { 'x-outreach-secret': 'test-secret' }) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  assert.equal((await post('/run/clinic-discovery/state', {}, {})).status, 401, 'no secret, no access');

  const state = (await post('/run/clinic-discovery/state', {})).body;
  assert.equal(state.cursor, 0);
  assert.equal(state.target, 200);
  assert.equal(state.areas.length, DEFAULT_AREAS.length);
  assert.match(state.userAgent, /ops@example\.com/);
  const before = state.storedToday;

  await query(`INSERT INTO discovery_site_checks (domain, email_found, detail) VALUES ($1, false, 'test') ON CONFLICT (domain) DO NOTHING`, [host('nomail')]);
  const known = (await post('/run/clinic-discovery/known', { domains: [host('old'), `https://www.${host('nomail')}/x`, host('new')] })).body;
  assert.deepEqual(known.known, [host('old')]);
  assert.deepEqual(known.noEmailRecently, [host('nomail')]);

  const candidate = (l, name, extra = {}) => ({
    name: `${name} ${tag}`, category: 'clinic', website: `https://${host(l)}/`, email: `info@${host(l)}`,
    emailSource: `https://${host(l)}/contact`, phone: '+13055550100', sourceRef: `node/${l.charCodeAt(0)}`,
    leader: { name: 'Ana Ruiz', role: 'Medical Director', credential: 'DO', sourceUrl: `https://${host(l)}/about` }, signals: ['hormone'], ...extra
  });
  const stored = (await post('/run/clinic-discovery/store', {
    area: DEFAULT_AREAS[3].label, areaIndex: 3,
    candidates: [
      candidate('a', 'Glow Longevity Clinic'),
      candidate('b', 'Vital Hormone Clinic', { email: `vitalclinic${tag}@gmail.com` }),
      candidate('c', 'Prime Wellness Clinic', { email: `info@agency-${tag}.example` }),
      candidate('d', 'Sunrise Nail Bar', { category: 'med-spa' }),
      candidate('old', 'Old Record Again Clinic'),
      candidate('a', 'Glow Longevity Clinic Branch'),
      candidate('e', 'Family Doctors', {})
    ],
    noEmailDomains: [host('quiet')]
  })).body;
  assert.equal(stored.stored, 2, JSON.stringify(stored));
  assert.equal(stored.duplicates, 2);
  assert.equal(stored.refused.personal_webmail, 1);
  assert.equal(stored.refused.email_not_on_site_domain, 1);
  assert.ok(stored.refused.tier_exclude || stored.refused.tier_low);
  assert.equal(stored.storedToday, before + 2);

  const row = (await query(`SELECT * FROM prospects WHERE business->>'name' = $1`, [`Glow Longevity Clinic ${tag}`])).rows[0];
  assert.equal(row.campaign_id, CAMPAIGN_ID);
  assert.equal(row.stage, 'discovered');
  assert.equal(row.contact.email, `info@${host('a')}`);
  assert.equal(row.business.leadership.name, 'Ana Ruiz');
  assert.equal(row.enrichment.discoveredBy, 'clinic-discovery');
  assert.equal(row.enrichment.source.type, 'public_directory');
  assert.ok(row.enrichment.verifiedAt);
  assert.equal(row.business.region, DEFAULT_AREAS[3].label);
  assert.ok((await query(`SELECT 1 FROM discovery_site_checks WHERE domain = $1`, [host('quiet')])).rowCount);
  assert.equal((await post('/run/clinic-discovery/state', {})).body.cursor, 4, 'cursor advanced past the stored metro');

  assert.equal((await post('/run/clinic-discovery/store', { area: 'nowhere', candidates: [] })).status, 400);

  const logged = (await post('/run/clinic-discovery/log', { totals: { queried: 1, found: 10, withWebsite: 9, withEmail: 3, stored: 2 }, metros: [{ area: 'x' }] })).body;
  assert.ok(logged.runId);
  const run = (await query('SELECT * FROM clinic_discovery_runs WHERE run_id = $1', [logged.runId])).rows[0];
  assert.deepEqual([run.queried, run.found, run.with_website, run.with_email, run.stored], [1, 10, 9, 3, 2]);
});

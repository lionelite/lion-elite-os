'use strict';

// A live run stops qualifying once it holds as many picks as its remaining time
// can send, instead of re-evaluating every candidate first. Production on
// 2026-11-22: ~930 candidates took ~5.5 minutes of an 8-minute run, leaving time
// for 2 sends. A dry run still evaluates everything. Skips without DATABASE_URL.

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('live run qualifies only as many clinics as it can send in its budget', { skip: !databaseConfigured, timeout: 60_000 }, async t => {
  const database = require('../lib/database');
  const { holdExclusiveDb } = require('./helpers/db-exclusive');
  const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
  const { createClinicOutreachRunner } = require('../lib/outreach/clinic-outreach-run');
  const { templateVersion } = require('../lib/outreach/clinic-supply-email');
  const { followUpVersion } = require('../lib/outreach/clinic-followup-email');
  const control = require('../lib/outreach/outreach-control');
  const { query } = database;

  const release = await holdExclusiveDb();
  const tag = Math.random().toString(36).slice(2, 8);
  t.after(async () => {
    await query(`DELETE FROM prospects WHERE business->>'name' LIKE $1`, [`%${tag}%`]).catch(() => {});
    await query(`DELETE FROM outreach_runs WHERE trigger LIKE 'capacity-test%'`).catch(() => {});
    await release();
    await database.close();
  });
  await database.migrate();
  await control.ensureSchema(database);
  await control.setPaused(database, false, { by: 'test' });

  const store = new PostgresProspectStore();
  const NOW = new Date('2026-11-04T15:00:00Z');
  let tick = NOW.getTime();
  const clock = () => new Date(tick += 1);
  const host = l => `${l}-${tag}.example`;
  const names = ['Glow Aesthetics Med Spa', 'Radiance Aesthetics Med Spa', 'Luxe Aesthetics Med Spa', 'Pure Aesthetics Med Spa', 'Bloom Aesthetics Med Spa', 'Nova Aesthetics Med Spa'];
  for (const [i, name] of names.entries()) {
    const letter = String.fromCharCode(97 + i);
    const { prospect } = await store.create({
      business: { name: `${name} ${tag}`, website: `https://${host(letter)}`, region: 'miami-fl', category: 'clinic_or_medspa', niche: 'med-spa', sourceRef: `osm:node/${i + 1}` },
      contact: { email: `info@${host(letter)}` },
      campaignId: 'osm-business-discovery',
    }, 'test');
    await store.update(prospect.prospectId, { enrichment: { verifiedAt: NOW.toISOString() } }, 'test');
  }

  const env = {
    OUTREACH_SEND_ENABLED: 'true', RESEND_API_KEY: 'stub', OUTREACH_FROM_EMAIL: 'stub@example.com',
    OUTREACH_START_DATE: '2026-01-05', DAILY_SEND_CAP: '150',
    OUTREACH_APPROVED_MESSAGE_VERSIONS: [templateVersion(1), followUpVersion()].join(','),
  };
  const sent = [];
  const runner = over => createClinicOutreachRunner({
    env, store, now: clock, sleep: async () => {}, random: () => 0, discover: async () => ({ stored: 0 }),
    mxCheck: async () => ({ ok: true, checkedAt: new Date(tick).toISOString() }),
    sendEmail: async ({ draft }) => { sent.push(draft.recipient); return { provider: 'resend', providerId: `re_${sent.length}` }; },
    mirror: async () => ({ status: 'skipped' }), logger: { log() {}, warn() {}, error() {} },
    ...over,
  });

  // Dry run: everything is evaluated (the report stays complete).
  const dry = await runner({ budgetMs: 60_000 }).run({ dryRun: true, trigger: 'capacity-test-dry' });
  assert.equal(dry.status, 'completed', JSON.stringify(dry.error || dry.notes));
  const ours = dry.wouldSend.filter(w => w.email.endsWith(`${tag}.example`));
  assert.equal(ours.length, names.length, 'dry run evaluates and reports every eligible clinic');

  // Live, 75 s budget: room for 1 + floor(75 s / 30 s) = 3 sends, so 3 picks, and
  // the remaining candidates are left for the next run rather than evaluated now.
  const live = await runner({ budgetMs: 75_000 }).run({ trigger: 'capacity-test' });
  assert.equal(live.status, 'completed', JSON.stringify(live.error || live.notes));
  assert.equal(live.firstTouch.picked, 3);
  assert.equal(live.sent, 3);
  assert.equal(sent.length, 3);
  assert.ok(live.skipReasons['not evaluated: run already holds as many as it can send (next run)'] >= names.length - 3);
  assert.equal(live.skipped, live.examined - live.sent - live.failed);
});

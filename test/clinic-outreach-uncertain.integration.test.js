'use strict';

// Uncertain submissions and post-acceptance crashes, against a real Postgres:
//   1. a timeout is held as `uncertain`, not `failed`, and is not counted as sent;
//   2. uncertain messages reserve today's capacity (DAILY_EMAIL_LIMIT);
//   3. the next run re-submits it with the SAME idempotency key, then records it;
//   4. accepted-but-not-recorded keeps the provider id, is counted as sent in the
//      summary, and is held (never `failed`, never re-sent as new);
//   5. a live trigger outside the sending window sends nothing.
// Skips without DATABASE_URL.

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('uncertain submissions are held, reserve capacity, and retry only with the same key', { skip: !databaseConfigured, timeout: 60_000 }, async t => {
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
  const savedLimit = process.env.DAILY_EMAIL_LIMIT;
  t.after(async () => {
    if (savedLimit === undefined) delete process.env.DAILY_EMAIL_LIMIT; else process.env.DAILY_EMAIL_LIMIT = savedLimit;
    await query(`DELETE FROM prospects WHERE business->>'name' LIKE $1`, [`%${tag}%`]).catch(() => {});
    await query(`DELETE FROM outreach_runs WHERE trigger LIKE 'uncertain-test%'`).catch(() => {});
    await release();
    await database.close();
  });
  await database.migrate();
  await control.ensureSchema(database);
  await control.setPaused(database, false, { by: 'test' });
  // Park any sendable leftovers from other suites so only this test's clinics qualify.
  await query(`UPDATE outreach_queue SET status = 'sent' WHERE status IN ('processing','uncertain')`);

  // Real wall clock: daily_usage and the reservation query use the database's now().
  const store = new PostgresProspectStore();
  const host = l => `${l}-${tag}.example`;
  const make = async (letter, name) => {
    const { prospect } = await store.create({
      business: { name: `${name} ${tag}`, website: `https://${host(letter)}`, region: 'miami-fl', category: 'clinic_or_medspa', niche: 'med-spa', sourceRef: `osm:node/${letter}` },
      contact: { email: `info@${host(letter)}` }, campaignId: 'osm-business-discovery',
    }, 'test');
    await store.update(prospect.prospectId, { enrichment: { verifiedAt: new Date().toISOString() } }, 'test');
    return prospect;
  };
  const A = await make('a', 'Glow Aesthetics Med Spa');

  const env = {
    OUTREACH_SEND_ENABLED: 'true', RESEND_API_KEY: 'stub', OUTREACH_FROM_EMAIL: 'stub@example.com',
    OUTREACH_START_DATE: '2026-01-05', DAILY_SEND_CAP: '150', OUTREACH_SEND_WINDOW: '00:00-24:00',
    OUTREACH_APPROVED_MESSAGE_VERSIONS: [templateVersion(1), followUpVersion()].join(','),
  };
  const calls = [];
  let mode = 'timeout';
  const sendEmail = async ({ draft, authorization }) => {
    calls.push({ to: draft.recipient, key: authorization.idempotencyKey, mode });
    if (mode === 'timeout') throw Object.assign(new Error('timeout; outcome unknown'), { code: 'DELIVERY_OUTCOME_UNKNOWN', ambiguous: true });
    return { provider: 'resend', providerId: `re_${calls.length}` };
  };
  const runner = (over = {}) => createClinicOutreachRunner({
    env, store, sleep: async () => {}, random: () => 0, discover: async () => ({ stored: 0 }), sendEmail,
    mxCheck: async () => ({ ok: true, checkedAt: new Date().toISOString() }),
    mirror: async () => ({ status: 'skipped' }), logger: { log() {}, warn() {}, error() {} },
    ...over,
  });
  const queueRow = async id => (await query('SELECT * FROM outreach_queue WHERE prospect_id = $1', [id])).rows[0];

  // 1. Timeout → uncertain, not failed, not counted as sent.
  const usageBefore = (await store.getDailyEmailQuota()).sent;
  const first = await runner().run({ trigger: 'uncertain-test-1' });
  assert.equal(first.status, 'completed', JSON.stringify(first.error || first.notes));
  assert.equal(first.uncertain, 1);
  assert.equal(first.failed, 0);
  assert.equal(first.sent, 0);
  const held = await queueRow(A.prospectId);
  assert.equal(held.status, 'uncertain');
  assert.match(held.last_error, /^UNCERTAIN DELIVERY_OUTCOME_UNKNOWN/);
  assert.equal((await store.getDailyEmailQuota()).sent, usageBefore, 'an uncertain send is not counted as accepted');

  // 2. Reservation: with DAILY_EMAIL_LIMIT = usage + 1, the uncertain message
  //    occupies the last slot, so another message cannot reserve it.
  process.env.DAILY_EMAIL_LIMIT = String(usageBefore + 1);
  const limited = new PostgresProspectStore();
  const B = await make('b', 'Radiance Aesthetics Med Spa');
  const q = await limited.enqueue(B.prospectId, { authorized: true, idempotencyKey: `uncertain-test-${tag}-b` },
    { channel: 'email', recipient: `info@${host('b')}`, subject: 's', body: 'b', messageVersion: templateVersion(1) }, new Date().toISOString(), 'test');
  await assert.rejects(limited.markQueue(q.item.queueId, 'processing', {}, 'test'), e => e.code === 'DAILY_EMAIL_QUOTA_REACHED');
  await query('DELETE FROM outreach_queue WHERE queue_id = $1', [q.item.queueId]);
  await query(`UPDATE prospects SET stage = 'suppressed' WHERE prospect_id = $1`, [B.prospectId]);
  delete process.env.DAILY_EMAIL_LIMIT;

  // 3. Next run: reconciliation re-submits it with the SAME idempotency key and
  //    identical stored content, then records it once. (Rows touched in the last
  //    2 minutes are left alone in case a send is still in flight.)
  mode = 'ok';
  await query(`UPDATE outreach_queue SET updated_at = now() - interval '5 minutes' WHERE prospect_id = $1`, [A.prospectId]);
  const second = await runner().run({ trigger: 'uncertain-test-2' });
  assert.equal(second.sent, 1, JSON.stringify(second.skipReasons));
  assert.equal(second.reconcile.resolvedSent, 1);
  const toA = calls.filter(c => c.to === `info@${host('a')}`);
  assert.equal(toA.length, 2);
  assert.equal(toA[0].key, toA[1].key, 'retry reuses the provider idempotency key');
  assert.equal((await queueRow(A.prospectId)).status, 'sent');
  assert.equal((await store.getDailyEmailQuota()).sent, usageBefore + 1, 'counted exactly once');

  // 4. Accepted, then the DB write fails: provider id kept, held, never `failed`.
  const C = await make('c', 'Luxe Aesthetics Med Spa');
  // The store uses private fields, so the fault is patched onto the real instance.
  const realMarkQueue = store.markQueue.bind(store);
  store.markQueue = (id, status, meta, actor) => (status === 'sent'
    ? Promise.reject(new Error('connection reset'))
    : realMarkQueue(id, status, meta, actor));
  let crashed;
  try {
    crashed = await runner().run({ trigger: 'uncertain-test-3' });
  } finally {
    store.markQueue = realMarkQueue;
  }
  assert.equal(crashed.sent, 1, 'the provider accepted it, so it is reported as sent');
  const cRow = await queueRow(C.prospectId);
  assert.equal(cRow.status, 'uncertain');
  assert.ok(cRow.provider_message_id, 'provider message id preserved');
  assert.match(cRow.last_error, /^ACCEPTED_NOT_RECORDED/);
  assert.notEqual(cRow.status, 'failed');

  // 5. Outside the window: nothing is sent, whoever triggers it.
  const before = calls.length;
  const closed = await runner({ env: { ...env, OUTREACH_SEND_WINDOW: '00:00-00:01' }, now: () => new Date('2026-11-23T17:00:00Z') })
    .run({ trigger: 'uncertain-test-closed' });
  assert.equal(closed.status, 'skipped');
  assert.match(closed.reason, /outside the sending window/);
  assert.equal(calls.length, before);
});

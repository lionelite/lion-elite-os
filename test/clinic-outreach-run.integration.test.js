'use strict';

// The whole HTTP-triggered clinic outreach run against the real schema:
// discovery dedupe, first touch + follow-up sends, spacing, reply-stop,
// suppression, the never-email list, per-step idempotency, one run per day,
// the Postgres pause switch, dry runs and the inbound reply/opt-out recorder.
// Network (Overpass, websites, DNS, Resend, Google) is stubbed.
// Runs in CI (Postgres is provisioned); skips locally without DATABASE_URL.

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('clinic outreach run end to end', { skip: !databaseConfigured, timeout: 60_000 }, async t => {
  const database = require('../lib/database');
  const { holdExclusiveDb } = require('./helpers/db-exclusive');
  const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
  const { createClinicOutreachRunner, stepKey } = require('../lib/outreach/clinic-outreach-run');
  const { templateVersion } = require('../lib/outreach/clinic-supply-email');
  const { followUpVersion } = require('../lib/outreach/clinic-followup-email');
  const control = require('../lib/outreach/outreach-control');
  const { query } = database;

  const release = await holdExclusiveDb();
  const tag = Math.random().toString(36).slice(2, 8);
  t.after(async () => {
    await query(`DELETE FROM prospects WHERE business->>'name' LIKE $1 OR lower(contact->>'email') LIKE $2`, [`%${tag}%`, `%${tag}%`]).catch(() => {});
    await query(`DELETE FROM outreach_suppressions WHERE lower(address) LIKE $1`, [`%${tag}%`]).catch(() => {});
    await query(`DELETE FROM outreach_runs WHERE trigger LIKE 'integration-test%'`).catch(() => {});
    await query(`DELETE FROM app_settings WHERE key IN ($1,$2)`, [control.PAUSE_KEY, control.ROTATION_KEY]).catch(() => {});
    await release();
    await database.close();
  });
  await database.migrate();
  await query(`DELETE FROM outreach_runs WHERE trigger LIKE 'integration-test%'`);
  await query(`DELETE FROM app_settings WHERE key IN ($1,$2)`, [control.PAUSE_KEY, control.ROTATION_KEY]);
  // Only this test's clinics should be sendable; park anything another test left behind.
  const store = new PostgresProspectStore();

  const NOW = new Date('2026-11-10T14:07:00Z'); // Tuesday, 9:07 New York
  const host = l => `${l}-${tag}.example`;
  const mk = async (input, patch) => {
    const { prospect } = await store.create(input, 'test');
    if (patch) return store.update(prospect.prospectId, patch, 'test');
    return prospect;
  };
  const clinic = (letter, name, extra = {}) => ({
    business: { name: `${name} ${tag}`, website: `https://${host(letter)}`, region: 'miami-fl', category: 'clinic_or_medspa', ...extra.business },
    contact: { email: extra.email || `info@${host(letter)}` },
    campaignId: extra.campaignId || 'lion-elite-clinical',
  });

  const A = await mk({ ...clinic('a', 'Glow Aesthetics Med Spa', { campaignId: 'osm-business-discovery', business: { niche: 'med-spa', sourceRef: 'osm:node/1' } }) },
    { enrichment: { verifiedAt: NOW.toISOString() } });
  const contactedPatch = (extra = {}) => ({ stage: 'contacted', enrichment: { historical_sends: 1, last_sent: '2026-10-05', source: 'google_doc_master_contacts' }, ...extra });
  const B = await mk(clinic('b', 'Vitality Wellness Clinic'), contactedPatch());
  const C = await mk(clinic('c', 'Revive Wellness Clinic'), contactedPatch());
  const D = await mk(clinic('d', 'Renew Wellness Clinic'), contactedPatch());
  const E = await mk(clinic('e', 'Prime Wellness Clinic'), contactedPatch({ status: 'held' }));
  const F = await mk(clinic('f', 'Replied Wellness Clinic'), { stage: 'replied' });
  const LT = await mk({ ...clinic('t', 'Level T Wellness'), contact: { email: 'info@thelevelt.com' } }, contactedPatch());
  // C replied after selection would have happened; D opted out.
  await query(`INSERT INTO prospect_events (prospect_id, type, actor, data) VALUES ($1,'prospect.replied','test','{}')`, [C.prospectId]);
  await store.suppress({ address: `info@${host('d')}`, reason: 'opt_out' });

  const env = {
    OUTREACH_SEND_ENABLED: 'true', RESEND_API_KEY: 'stub', OUTREACH_FROM_EMAIL: 'stub@example.com', OUTREACH_POSTAL_ADDRESS: '1 Test St',
    OUTREACH_START_DATE: '2026-01-05', DAILY_SEND_MAX: '150',
    OUTREACH_APPROVED_MESSAGE_VERSIONS: [templateVersion(1), followUpVersion()].join(','),
  };

  // Overpass stub: one known domain (B), one new clinic (G), one whose e-mail is A's.
  const overpass = async () => ({
    ok: true, status: 200,
    json: async () => ({ elements: [
      { type: 'node', id: 9001, tags: { name: `Known Wellness ${tag}`, website: `https://${host('b')}`, amenity: 'clinic' } },
      { type: 'node', id: 9002, tags: { name: `Tag Longevity Clinic ${tag}`, website: `https://${host('g')}`, 'contact:email': `info@${host('g')}`, amenity: 'clinic' } },
      { type: 'node', id: 9003, tags: { name: `Duplicate Aesthetics ${tag}`, website: `https://other-${tag}.example`, 'contact:email': `info@${host('a')}`, amenity: 'clinic' } },
    ] }),
  });

  const sent = [];
  const gaps = [];
  const mirrored = [];
  const ours = id => [A, B, C, D, E, F, LT].some(p => p.prospectId === id) || sent.some(s => s.prospectId === id);
  const runner = (overrides = {}) => createClinicOutreachRunner({
    env, store, now: () => NOW, sleep: async ms => { gaps.push(ms); }, random: () => 0.5,
    discoveryFetch: overpass, enrichEmail: async () => null, enrichDelayMs: 0,
    mxCheck: async () => ({ ok: true, checkedAt: NOW.toISOString() }),
    sendEmail: async ({ draft, prospect, authorization }) => { sent.push({ prospectId: prospect.prospectId, to: draft.recipient, version: draft.messageVersion, key: authorization.idempotencyKey }); return { providerId: `re_${sent.length}` }; },
    mirror: async rows => { mirrored.push(...rows); return { status: 'mirrored', rows: rows.length }; },
    logger: { log() {}, warn() {}, error() {} },
    ...overrides,
  });

  // Dry run first: nothing is queued or sent.
  const dry = await runner().run({ dryRun: true, trigger: 'integration-test-dry' });
  assert.equal(dry.status, 'completed');
  assert.equal(sent.length, 0);
  assert.ok(dry.wouldSend.some(w => w.email === `info@${host('b')}`), 'dry run reports who would be sent');
  assert.equal((await query('SELECT COUNT(*)::int n FROM outreach_queue q JOIN prospects p USING (prospect_id) WHERE p.business->>\'name\' LIKE $1', [`%${tag}%`])).rows[0].n, 0);

  const summary = await runner().run({ trigger: 'integration-test' });
  if (process.env.PRINT_SUMMARY) console.log(JSON.stringify(summary, null, 2));
  assert.equal(summary.status, 'completed', JSON.stringify(summary.error || summary.notes));

  // Discovery: G stored with a source; B's domain and A's e-mail were deduped.
  const G = (await query(`SELECT * FROM prospects WHERE lower(contact->>'email') = $1`, [`info@${host('g')}`])).rows[0];
  assert.ok(G, 'new clinic stored');
  assert.equal(G.enrichment.source.provider, 'openstreetmap-overpass');
  assert.equal((await query(`SELECT COUNT(*)::int n FROM prospects WHERE business->>'name' IN ($1,$2)`, [`Known Wellness ${tag}`, `Duplicate Aesthetics ${tag}`])).rows[0].n, 0, 'known domain and known e-mail not inserted');
  assert.ok(summary.discovery.skippedKnownDomain >= 1);
  assert.ok(summary.discovery.duplicates >= 1);

  const ourSends = sent.filter(s => ours(s.prospectId) || s.prospectId === G.prospect_id);
  const to = ourSends.map(s => s.to);
  assert.ok(to.includes(`info@${host('a')}`), 'first touch to A');
  assert.ok(to.includes(`info@${host('g')}`), 'first touch to newly discovered G');
  assert.ok(to.includes(`info@${host('b')}`), 'follow-up to contacted B');
  for (const never of ['info@thelevelt.com', `info@${host('c')}`, `info@${host('d')}`, `info@${host('e')}`, `info@${host('f')}`]) {
    assert.ok(!to.includes(never), `${never} must not be e-mailed`);
  }
  assert.equal(ourSends.find(s => s.to === `info@${host('b')}`).version, followUpVersion());
  assert.equal(ourSends.find(s => s.to === `info@${host('b')}`).key, stepKey(B.prospectId, 'med_spa_research_supply', 'followup1'));
  // First touches go before follow-ups; every gap is 30–90 s.
  const order = sent.map(s => s.version.startsWith('clinic-supply-followup') ? 'f' : '1').join('');
  assert.match(order, /^1*f*$/);
  // One gap before every picked item after the first (stopped ones included): no bursts.
  assert.equal(gaps.length, summary.firstTouch.picked + summary.followUp.picked - 1);
  for (const g of gaps) assert.ok(g >= 30_000 && g <= 90_000);

  // Reply-stop: C was picked but stopped before send and marked replied.
  assert.ok(summary.stopped.some(s => s.prospectId === C.prospectId && s.stop === 'replied'));
  assert.equal((await store.get(C.prospectId)).stage, 'replied');
  assert.equal((await store.get(A.prospectId)).stage, 'contacted');
  assert.equal((await store.get(B.prospectId)).stage, 'contacted');
  assert.equal((await store.get(LT.prospectId)).stage, 'contacted', 'Level T untouched');

  // Summary row and mirror.
  const runRow = (await query('SELECT * FROM outreach_runs WHERE run_id = $1', [summary.runId])).rows[0];
  assert.equal(runRow.status, 'completed');
  assert.equal(runRow.sent, summary.sent);
  assert.ok(summary.skipReasons['never-email list'] >= 1);
  assert.ok(mirrored.some(r => r.prospectId === B.prospectId && r.stage === 'contacted'));
  assert.ok(summary.sent >= 3);
  assert.equal(summary.skipped, summary.examined - summary.sent - summary.failed);

  // Same New York day: refused.
  const again = await runner().run({ trigger: 'integration-test' });
  assert.equal(again.status, 'skipped');
  assert.match(again.reason, /already completed/);

  // Next day: nobody already e-mailed by this pipeline is e-mailed again.
  const before = sent.length;
  const nextDay = new Date(NOW.getTime() + 86_400_000);
  const day2 = await runner({ now: () => nextDay, discover: async () => ({ stored: 0 }) }).run({ trigger: 'integration-test' });
  assert.equal(day2.status, 'completed');
  const resent = sent.slice(before).filter(s => [A.prospectId, B.prospectId, G.prospect_id].includes(s.prospectId));
  assert.deepEqual(resent, [], 'per-step idempotency and cadence hold across runs');

  // Pause switch.
  await control.setPaused(database, true, { reason: 'test', by: 'test' });
  const paused = await runner({ now: () => new Date(NOW.getTime() + 2 * 86_400_000) }).run({ trigger: 'integration-test' });
  assert.equal(paused.status, 'paused');
  await control.setPaused(database, false, { by: 'test' });

  // Weekend: refused for real sends.
  const saturday = await runner({ now: () => new Date('2026-11-14T14:07:00Z') }).run({ trigger: 'integration-test' });
  assert.equal(saturday.status, 'skipped');

  // Overpass unreachable → Nominatim fallback still grows the pipeline (dry run, so no sends).
  const fallback = await runner({
    now: () => new Date(NOW.getTime() + 3 * 86_400_000),
    discoveryFetch: async () => { throw new TypeError('fetch failed'); },
    nominatimSleep: async () => {},
    nominatimFetch: async url => ({ ok: true, status: 200, json: async () => (new URL(url).searchParams.get('q') === 'longevity'
      ? [{ osm_type: 'node', osm_id: 77, name: `Nominatim Longevity Clinic ${tag}`, category: 'amenity', type: 'clinic',
          extratags: { website: `https://${host('n')}`, email: `info@${host('n')}` } }] : []) }),
  }).run({ dryRun: true, trigger: 'integration-test-fallback' });
  assert.equal(fallback.status, 'completed');
  assert.match(fallback.discovery.source, /nominatim/);
  assert.ok(fallback.discovery.overpassError);
  assert.equal(fallback.discovery.stored, 1);
  const N = (await query(`SELECT * FROM prospects WHERE lower(contact->>'email') = $1`, [`info@${host('n')}`])).rows[0];
  assert.ok(N, 'fallback clinic stored');
  assert.equal(N.stage, 'qualified', 'and qualified in the same run');

  // Inbound recorder: an opt-out suppresses the address and every record holding it.
  const inbound = await runner().recordInbound({ email: `INFO@${host('b')}`, type: 'opt_out' });
  assert.equal(inbound.prospectsUpdated, 1);
  assert.equal((await store.get(B.prospectId)).status, 'suppressed');
  const reply = await runner().recordInbound({ email: `info@${host('a')}`, type: 'reply' });
  assert.equal(reply.prospectsUpdated, 1);
  assert.equal((await store.get(A.prospectId)).stage, 'replied');
});

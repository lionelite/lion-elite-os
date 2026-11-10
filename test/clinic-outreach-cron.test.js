'use strict';

// Offline tests for the HTTP-triggered clinic outreach run: cap math, the
// never-email list, the follow-up copy, follow-up qualification (suppression,
// stop flags, cadence, frequency), the cron secret and the Sheets mirror.
// The full run against Postgres is in clinic-outreach-run.integration.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { effectiveDailyCap, newYorkClock, isNewYorkWeekday, sendGapMs } = require('../lib/outreach/send-cap');
const { isNeverEmail, neverEmailReason } = require('../lib/outreach/never-email');
const { buildClinicFollowUpEmail, followUpVersion } = require('../lib/outreach/clinic-followup-email');
const { qualifyFollowUp } = require('../lib/outreach/followup-qualification');
const { validateProspect } = require('../lib/outreach-validation');
const { secretMatches } = require('../routes/clinic-outreach-cron');
const { mirrorProspects, signedJwt, HEADER } = require('../lib/outreach/sheets-mirror');
const { stepKey } = require('../lib/outreach/clinic-outreach-run');
const { pauseState } = require('../lib/outreach/outreach-control');

const DAY = 86_400_000;

test('cap: 20 in week 0, +10 per FULL week, never above DAILY_SEND_MAX', () => {
  const start = '2026-11-10';
  const at = days => new Date(new Date('2026-11-10T14:07:00Z').getTime() + days * DAY);
  const env = { OUTREACH_START_DATE: start, DAILY_SEND_MAX: '150' };
  assert.equal(effectiveDailyCap({ now: at(0), env }).cap, 20);
  assert.equal(effectiveDailyCap({ now: at(6), env }).cap, 20, 'six days is not a full week');
  assert.equal(effectiveDailyCap({ now: at(7), env }).cap, 30);
  assert.equal(effectiveDailyCap({ now: at(20), env }).cap, 40);
  assert.equal(effectiveDailyCap({ now: at(91), env }).cap, 150, '13 weeks → 150');
  assert.equal(effectiveDailyCap({ now: at(400), env }).cap, 150, 'capped at DAILY_SEND_MAX');
  assert.equal(effectiveDailyCap({ now: at(400), env: { ...env, DAILY_SEND_MAX: '60' } }).cap, 60);
});

test('cap: fails safe — before start is 0, missing/invalid start holds the first step', () => {
  assert.equal(effectiveDailyCap({ now: new Date('2026-11-09T14:00:00Z'), env: { OUTREACH_START_DATE: '2026-11-10' } }).cap, 0);
  assert.equal(effectiveDailyCap({ now: new Date('2027-06-01'), env: {} }).cap, 20);
  assert.equal(effectiveDailyCap({ now: new Date('2027-06-01'), env: { OUTREACH_START_DATE: 'soon' } }).cap, 20);
  assert.equal(effectiveDailyCap({ now: new Date('2027-06-01'), env: { DAILY_SEND_MAX: '5' } }).cap, 5);
});

test('schedule: New York weekday and DST-correct clock; 30–90 s gaps', () => {
  // 2026-11-13 is a Friday; 14:07 UTC is 9:07 EST.
  assert.deepEqual(newYorkClock(new Date('2026-11-13T14:07:00Z')), { weekday: 'Fri', date: '2026-11-13', hour: 9, minute: 7 });
  // 13:07 UTC in July is 9:07 EDT.
  assert.equal(newYorkClock(new Date('2026-07-15T13:07:00Z')).hour, 9);
  assert.equal(isNewYorkWeekday(new Date('2026-11-14T14:07:00Z')), false, 'Saturday');
  // Saturday 02:00 UTC is still Friday evening in New York.
  assert.equal(isNewYorkWeekday(new Date('2026-11-14T02:00:00Z')), true);
  assert.equal(sendGapMs(() => 0), 30_000);
  assert.equal(sendGapMs(() => 0.9999999), 89_999);
});

test('never-email list: Level T and asim.hasnie, case-insensitive, env can only add', () => {
  assert.ok(isNeverEmail('INFO@thelevelt.com'));
  assert.ok(isNeverEmail('someone.else@thelevelt.com'), 'whole Level T organisation');
  assert.ok(isNeverEmail('asim.hasnie@intechaero.com'));
  assert.ok(!isNeverEmail('info@glowmedspa.com'));
  assert.ok(isNeverEmail('info@glowmedspa.com', { OUTREACH_NEVER_EMAIL: 'glowmedspa.com' }));
  assert.ok(isNeverEmail('x@y.com', { OUTREACH_NEVER_EMAIL: ' X@Y.com ' }));
  assert.ok(isNeverEmail('info@thelevelt.com', { OUTREACH_NEVER_EMAIL: '' }), 'cannot be removed by env');
  assert.match(neverEmailReason('asim.hasnie@intechaero.com'), /never-email/);
});

test('follow-up copy: 60–90 words, supplier comparison, RUO, opt-out, compliant', () => {
  const d = buildClinicFollowUpEmail({ businessName: 'Glow Med Spa', category: 'clinic_or_medspa' });
  assert.ok(d.messageWordCount >= 60 && d.messageWordCount <= 90, `${d.messageWordCount} words`);
  assert.match(d.body, /side-by-side supplier comparison/);
  assert.match(d.body, /laboratory research purposes only/);
  assert.match(d.body, /won't contact you again/);
  assert.doesNotMatch(d.body, /patient|dose|dosing|treat/i);
  assert.equal(d.approved, true);
  assert.deepEqual(d.quality.blockers, []);
  assert.match(d.messageVersion, /^clinic-supply-followup-v1-[0-9a-f]{8}$/);
  assert.equal(d.messageVersion, followUpVersion());
});

function contacted(overrides = {}) {
  return {
    prospectId: '11111111-1111-4111-8111-111111111111',
    campaignId: 'lion-elite-clinical',
    stage: 'contacted',
    status: 'active',
    business: { name: 'Glow Med Spa', website: 'https://glowmedspa.com', category: 'clinic_or_medspa' },
    contact: { email: 'info@glowmedspa.com' },
    enrichment: { historical_sends: 1, last_sent: '2026-10-05' },
    ...overrides,
  };
}
const NOW = new Date('2026-11-10T14:07:00Z');
const okFacts = { suppression: null, priorFollowUps: 0, recentQueueSends: 0, domainFollowedUpElsewhere: 0, mx: { ok: true, checkedAt: NOW.toISOString() } };
const approvedEnv = { OUTREACH_APPROVED_MESSAGE_VERSIONS: followUpVersion() };

test('follow-up qualification: a clean contacted clinic passes all 16 checks', () => {
  const q = qualifyFollowUp(contacted(), okFacts, { now: NOW, env: approvedEnv });
  assert.deepEqual(q.blockers, []);
  const v = validateProspect(q.view, q.policy, { now: NOW });
  assert.equal(v.passed, true, v.failedChecks.join(','));
});

test('follow-up qualification: unapproved message version blocks', () => {
  const q = qualifyFollowUp(contacted(), okFacts, { now: NOW, env: {} });
  assert.equal(q.qualified, false);
  assert.ok(q.blockers.some(b => b.startsWith('messageVersion')));
});

test('follow-up qualification: suppression, held, do_not_contact and never-list all block', () => {
  const cases = [
    [contacted(), { ...okFacts, suppression: { address: 'info@glowmedspa.com', reason: 'opt_out' } }, 'suppression'],
    [contacted({ status: 'held' }), okFacts, 'eligibility'],
    [contacted({ stage: 'suppressed' }), okFacts, 'eligibility'],
    [contacted({ stage: 'replied' }), okFacts, 'eligibility'],
    [contacted({ stage: 'disqualified' }), okFacts, 'eligibility'],
    [contacted({ contact: { email: 'info@glowmedspa.com', do_not_contact: true } }), okFacts, 'suppression'],
    [contacted({ contact: { email: 'info@thelevelt.com' }, business: { name: 'Level T', website: 'https://thelevelt.com' } }), okFacts, 'neverEmail'],
    [contacted({ contact: { email: 'asim.hasnie@intechaero.com' }, business: { name: 'Intech Wellness', website: 'https://intechaero.com' } }), okFacts, 'neverEmail'],
  ];
  for (const [prospect, facts, check] of cases) {
    const q = qualifyFollowUp(prospect, facts, { now: NOW, env: approvedEnv });
    assert.equal(q.qualified, false, `${prospect.stage}/${prospect.status}/${prospect.contact.email}`);
    assert.ok(q.blockers.some(b => b.startsWith(check)), `${check} expected in ${q.blockers.join(' | ')}`);
    assert.equal(validateProspect(q.view, q.policy, { now: NOW }).passed, false);
  }
});

test('follow-up qualification: one follow-up only, minimum gap, frequency window, MX, personal mailbox', () => {
  const block = (p, f, check) => {
    const q = qualifyFollowUp(p, f, { now: NOW, env: approvedEnv });
    assert.ok(q.blockers.some(b => b.startsWith(check)), `${check} expected in ${q.blockers.join(' | ')}`);
  };
  block(contacted(), { ...okFacts, priorFollowUps: 1 }, 'cadence');
  block(contacted({ enrichment: { historical_sends: 1, last_sent: '2026-11-01' } }), okFacts, 'cadence');
  block(contacted({ enrichment: { historical_sends: 3, last_sent: '2026-10-25' } }), okFacts, 'frequency');
  block(contacted(), { ...okFacts, mx: { ok: false, detail: 'no MX records' } }, 'verifiedAt');
  block(contacted({ contact: { email: 'glowmedspa@gmail.com' } }), okFacts, 'identity');
  block(contacted(), { ...okFacts, domainFollowedUpElsewhere: 1 }, 'duplicate');
  // Three October sends whose last one is outside the 30-day window are fine.
  assert.equal(qualifyFollowUp(contacted({ enrichment: { historical_sends: 3, last_sent: '2026-10-05' } }), okFacts, { now: NOW, env: approvedEnv }).qualified, true);
});

test('idempotency key is per prospect + campaign + step', () => {
  const a = stepKey('p1', 'med_spa_research_supply', 'followup1');
  assert.equal(a, stepKey('p1', 'med_spa_research_supply', 'followup1'));
  assert.notEqual(a, stepKey('p1', 'med_spa_research_supply', 'step1'));
  assert.notEqual(a, stepKey('p2', 'med_spa_research_supply', 'followup1'));
});

test('pause switch fails closed when the setting cannot be read', async () => {
  const broken = { query: async () => { throw new Error('relation "app_settings" does not exist'); } };
  assert.equal((await pauseState(broken)).paused, true);
  const empty = { query: async () => ({ rowCount: 0, rows: [] }) };
  assert.equal((await pauseState(empty)).paused, false);
  assert.equal((await pauseState(empty, { redisHalted: async () => true })).paused, true, 'Redis switch still honoured when present');
  const paused = { query: async () => ({ rowCount: 1, rows: [{ value: { paused: true, reason: 'test' } }] }) };
  assert.equal((await pauseState(paused)).paused, true);
});

test('cron secret: constant-time match, unset secret never matches', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abd', 'abc'), false);
  assert.equal(secretMatches('', ''), false);
  assert.equal(secretMatches(undefined, undefined), false);
  assert.equal(secretMatches('abc', ''), false);
});

test('sheets mirror: skips without credentials, writes a header to an empty tab, appends rows', async () => {
  assert.equal((await mirrorProspects([{}], { env: {} })).status, 'skipped');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { client_email: 'mirror@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const jwt = signedJwt(account);
  const [h, c, s] = jwt.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));

  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
    if (!opts.method) return { ok: true, status: 200, json: async () => ({}) }; // empty tab
    return { ok: true, status: 200, json: async () => ({ updates: {} }) };
  };
  const result = await mirrorProspects([
    { prospectId: 'p1', business: { name: 'Glow Med Spa', website: 'glowmedspa.com' }, contact: { email: 'info@glowmedspa.com' }, stage: 'contacted', status: 'active' },
  ], { env: { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(account) }, fetchImpl });
  assert.equal(result.status, 'mirrored');
  const append = calls.find(c2 => c2.opts.method === 'POST' && c2.url.includes(':append'));
  assert.match(append.url, /1Dwv2gD0BHsHmCgPKHBUR_qeC8msKWjiwL-o7OMAdPoE/);
  assert.match(decodeURIComponent(append.url), /Pipeline!A1/);
  const values = JSON.parse(append.opts.body).values;
  assert.deepEqual(values[0], [...HEADER]);
  assert.equal(values[1][3], 'info@glowmedspa.com');

  const failing = await mirrorProspects([{ prospectId: 'p1' }], { env: { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(account) },
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'denied' }) }) });
  assert.equal(failing.status, 'failed', 'a mirror failure is reported, never thrown');
});

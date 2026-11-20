'use strict';

// POST /run/clinic-outreach, GET /health/outreach, DAILY_SEND_CAP, the per-run
// log line, and the discovery source changes (Overpass website filter, Nominatim
// 429 stop + identifying User-Agent). Offline: no network, no database.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createOutreachRunRouter } = require('../routes/outreach-run');
const { effectiveDailyCap } = require('../lib/outreach/send-cap');
const { formatRunLine, deliveryConfigured } = require('../lib/outreach/clinic-outreach-run');
const { buildQuery, discoveryUserAgent } = require('../lib/discovery/osm-source');
const { fetchBusinessesNominatim, resetThrottle } = require('../lib/discovery/nominatim-source');

const quiet = { log() {}, warn() {}, error() {} };

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

function fakeRunner() {
  const calls = [];
  return {
    calls,
    run: async opts => { calls.push(['run', opts]); return { status: 'completed', sent: 2, dryRun: Boolean(opts.dryRun) }; },
    sendTestEmail: async () => { calls.push(['test']); return { status: 'test_sent', provider: 'resend', providerMessageId: 're_test_1' }; },
  };
}

const rejectingOidc = { verify: async () => { throw Object.assign(new Error('bad'), { code: 'OIDC_BAD_SIGNATURE' }); } };

test('/run/clinic-outreach: 401 without the secret, and never open when OUTREACH_SECRET is unset', async () => {
  for (const env of [{ OUTREACH_SECRET: 's3cret-value' }, {}]) {
    const runner = fakeRunner();
    const { base, close } = await serve(createOutreachRunRouter({ runner, env, oidcVerifier: rejectingOidc, logger: quiet }));
    try {
      assert.equal((await fetch(`${base}/run/clinic-outreach`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`${base}/run/clinic-outreach`, { method: 'POST', headers: { 'x-outreach-secret': 'wrong' } })).status, 401);
      assert.equal((await fetch(`${base}/run/clinic-outreach`, { method: 'POST', headers: { 'x-outreach-secret': '' } })).status, 401);
      assert.equal((await fetch(`${base}/run/clinic-outreach`, { method: 'POST', headers: { authorization: 'Bearer forged' } })).status, 401);
      assert.equal(runner.calls.length, 0, 'nothing ran');
    } finally { await close(); }
  }
});

test('/run/clinic-outreach: the right secret runs one batch; dryRun and test are honoured', async () => {
  const runner = fakeRunner();
  const { base, close } = await serve(createOutreachRunRouter({ runner, env: { OUTREACH_SECRET: 's3cret-value' }, oidcVerifier: rejectingOidc, logger: quiet, heartbeatMs: 5 }));
  const h = { 'x-outreach-secret': 's3cret-value', 'content-type': 'application/json' };
  try {
    const live = await (await fetch(`${base}/run/clinic-outreach`, { method: 'POST', headers: h })).json();
    assert.equal(live.status, 'completed');
    assert.deepEqual(runner.calls[0], ['run', { dryRun: false, trigger: 'secret/http' }]);

    const dry = await (await fetch(`${base}/run/clinic-outreach?dryRun=1`, { method: 'POST', headers: h })).json();
    assert.equal(dry.dryRun, true);

    const t = await (await fetch(`${base}/run/clinic-outreach?test=1`, { method: 'POST', headers: h })).json();
    assert.deepEqual(t, { status: 'test_sent', provider: 'resend', providerMessageId: 're_test_1' });
    assert.deepEqual(runner.calls[2], ['test']);
  } finally { await close(); }
});

test('/run/clinic-outreach: a verified GitHub OIDC token is also accepted', async () => {
  const runner = fakeRunner();
  const oidc = { verify: async token => { assert.equal(token, 'good'); return { workflow: 'clinic-outreach.yml', event: 'schedule' }; } };
  const { base, close } = await serve(createOutreachRunRouter({ runner, env: {}, oidcVerifier: oidc, logger: quiet, heartbeatMs: 5 }));
  try {
    const res = await (await fetch(`${base}/run/clinic-outreach`, { method: 'POST', headers: { authorization: 'Bearer good' } })).json();
    assert.equal(res.status, 'completed');
    assert.equal(runner.calls[0][1].trigger, 'github/clinic-outreach.yml/schedule');
  } finally { await close(); }
});

test('/health/outreach: last run, sends today, cap and the most recent error, with e-mail addresses redacted', async () => {
  const database = {
    query: async sql => {
      if (/FROM outreach_runs ORDER BY started_at DESC LIMIT 1/.test(sql)) return { rows: [{ run_id: 'r1', status: 'completed', sent: 4, started_at: '2026-11-20T14:00:00Z', finished_at: '2026-11-20T14:20:00Z' }] };
      if (/COUNT\(\*\)::int AS n FROM outreach_queue/.test(sql)) return { rows: [{ n: 4 }] };
      if (/FROM outreach_runs WHERE status = 'error'/.test(sql)) return { rows: [{ at: '2026-11-19T10:00:00Z', message: 'old' }] };
      if (/FROM outreach_queue\s+WHERE status = 'failed'/.test(sql)) return { rows: [{ at: '2026-11-20T14:10:00Z', message: 'DELIVERY_PROVIDER_ERROR: bounced for info@clinic.example' }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const { base, close } = await serve(createOutreachRunRouter({ runner: fakeRunner(), env: { DAILY_SEND_CAP: '150', OUTREACH_START_DATE: '2026-08-01' }, database, oidcVerifier: rejectingOidc, logger: quiet }));
  try {
    const body = await (await fetch(`${base}/health/outreach`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.lastRunAt, '2026-11-20T14:20:00Z');
    assert.equal(body.sendsToday, 4);
    assert.equal(body.dailySendCap, 150);
    assert.equal(body.lastError.source, 'send', 'newest error wins');
    assert.doesNotMatch(body.lastError.message, /@/, 'no e-mail address in a public endpoint');
  } finally { await close(); }
});

test('DAILY_SEND_CAP: default 150, overrides DAILY_SEND_MAX, blank means unset', () => {
  const now = new Date('2027-06-01T15:00:00Z');
  const start = { OUTREACH_START_DATE: '2026-08-01' };
  assert.equal(effectiveDailyCap({ now, env: start }).cap, 150);
  assert.equal(effectiveDailyCap({ now, env: { ...start, DAILY_SEND_CAP: '60' } }).cap, 60);
  assert.equal(effectiveDailyCap({ now, env: { ...start, DAILY_SEND_CAP: '40', DAILY_SEND_MAX: '90' } }).cap, 40);
  assert.equal(effectiveDailyCap({ now, env: { ...start, DAILY_SEND_CAP: '', DAILY_SEND_MAX: '90' } }).cap, 90);
  assert.equal(effectiveDailyCap({ now, env: { ...start, DAILY_SEND_CAP: '   ' } }).cap, 150);
});

test('sending needs the switch, the key and a from address; the postal address is always supplied', () => {
  assert.equal(deliveryConfigured({ OUTREACH_SEND_ENABLED: 'true', RESEND_API_KEY: 'k', OUTREACH_FROM_EMAIL: 'a@b.co' }), true);
  assert.equal(deliveryConfigured({ RESEND_API_KEY: 'k', OUTREACH_FROM_EMAIL: 'a@b.co' }), false, 'switch stays the owner\'s');
  assert.equal(deliveryConfigured({ OUTREACH_SEND_ENABLED: 'true', OUTREACH_FROM_EMAIL: 'a@b.co' }), false);
});

test('run log line names found / contacts / eligible / sent / errors', () => {
  const line = formatRunLine({
    status: 'completed', runId: 'r1', dryRun: false, qualified: 5, sent: 4, failed: 1, cap: { effective: 150, sentToday: 0 },
    discovery: { area: 'miami-fl, tampa-fl', found: 30, stored: 6, emailsFound: 6, skippedNoEmail: 9, cachedAreas: ['tampa-fl'],
      unreachableCategories: [{ area: 'miami-fl', category: 'clinic', message: 'timeout' }], errors: [] },
    sends: [{ outcome: 'failed', prospectId: 'p9', reason: 'DELIVERY_PROVIDER_ERROR: 422' }],
  });
  for (const part of ['run COMPLETED', 'clinicsFound=30', 'newClinics=6', 'contactsFound=6', 'noEmailSkipped=9', 'cachedAreas=1', 'eligibleLeads=5', 'emailsSent=4', 'failed=1', 'errors=2', 'miami-fl clinic unreachable']) {
    assert.ok(line.includes(part), `${part} in ${line}`);
  }
});

test('Overpass: websiteOnly asks only for listings carrying a website tag', () => {
  const area = { south: 41.4, west: -81.85, north: 41.6, east: -81.55 };
  const q = buildQuery({ area, categories: ['clinic'], websiteOnly: true });
  assert.match(q, /nwr\["amenity"="clinic"\]\["website"\]/);
  assert.match(q, /nwr\["amenity"="doctors"\]\["contact:website"\]/);
  assert.match(q, /nwr\["healthcare"="clinic"\]\["website"\]/);
  assert.doesNotMatch(buildQuery({ area, categories: ['clinic'] }), /\["website"\]/, 'default unchanged for other callers');
});

test('OSM User-Agent identifies us with a contact e-mail from configuration', () => {
  assert.match(discoveryUserAgent({ OSM_CONTACT_EMAIL: 'ops@example.com' }), /LionEliteOS\/1\.1 .*ops@example\.com/);
  assert.match(discoveryUserAgent({ OUTREACH_FROM_EMAIL: 'Alex <alex@example.com>' }), /; alex@example\.com\)$/);
  assert.doesNotMatch(discoveryUserAgent({}), /@/);
});

test('Nominatim: stops at the first 429 instead of firing the remaining searches, spaced ≥1 s, with our User-Agent', async () => {
  resetThrottle();
  const urls = [];
  const agents = [];
  const sleeps = [];
  const area = { label: 'x', south: 41.4, west: -81.85, north: 41.6, east: -81.55 };
  await assert.rejects(
    fetchBusinessesNominatim({
      area, logger: quiet, userAgent: 'UA-test (ops@example.com)', sleepImpl: async ms => { sleeps.push(ms); },
      fetchImpl: async (url, opts) => { urls.push(url); agents.push(opts.headers['user-agent']); return { ok: false, status: 429, json: async () => ({}) }; },
    }),
    err => err.code === 'NOMINATIM_RATE_LIMITED',
  );
  assert.equal(urls.length, 1, 'one request, then stop');
  assert.equal(agents[0], 'UA-test (ops@example.com)');

  // Healthy: every request after the first waits for the 1.1 s floor.
  resetThrottle();
  let clock = 1_000_000;
  const ok = await fetchBusinessesNominatim({
    area, logger: quiet, terms: ['med spa', 'aesthetics', 'longevity'], nowImpl: () => clock,
    sleepImpl: async ms => { sleeps.push(ms); clock += ms; },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  assert.deepEqual(ok.businesses, []);
  assert.ok(sleeps.slice(-2).every(ms => ms >= 1000), `spacing ${sleeps}`);
});

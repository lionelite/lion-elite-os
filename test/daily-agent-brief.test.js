'use strict';

// The daily agent brief: rules (lib/agents/daily-brief.js) and the endpoint
// (routes/agent-brief.js). Offline: no database, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { buildBrief, laneOfLead } = require('../lib/agents/daily-brief');
const { QUERIES } = require('../lib/agents/brief-metrics');
const { createAgentBriefRouter } = require('../routes/agent-brief');
const { ROLES } = require('../lib/agents/roles');

const NOW = new Date('2026-11-23T11:20:00Z'); // Monday 06:20 New York

// Shape and values taken from production on 2026-11-23 (counts only, no PII).
function realisticMetrics(overrides = {}) {
  return {
    clinicFunnel: { rows: [{ stage: 'qualified', n: 194 }, { stage: 'discovered', n: 558 }, { stage: 'contacted', n: 176 }, { stage: 'suppressed', n: 5 }] },
    clinicReplies: { rows: [{ total: 0, last7: 0 }] },
    sendsByDay: { rows: [{ day: '2026-11-22', sent: 11 }, { day: '2026-11-21', sent: 3 }, { day: '2026-11-20', sent: 25 }] },
    outreachRuns24h: { rows: [{ trigger: 'github/x', status: 'completed', sent: 7, skip_reasons: { 'first touch: eligibility': 533, 'run time budget reached (eligible next run)': 136, 'follow-up: cadence': 119 } }] },
    schedulerTicks24h: { rows: [] },
    discoveryRuns24h: { rows: [{ runs: 4, stored: 259, found: 1959 }] },
    outreachPaused: { rows: [{ value: { paused: false } }] },
    storeOrders: { rows: [{ y_orders: 0, y_revenue: 0, d7_orders: 2, d7_revenue: 288.97, prev7_orders: 2, prev7_revenue: 665.93, d30_orders: 6, d30_revenue: 2043.81 }] },
    coachingClients: { rows: [] },
    coachingCheckins7d: { rows: [{ n: 0 }] },
    capturedLeads: { rows: [] },
    funnelLeads: { rows: [{ total: 0, last7: 0 }] },
    funnelEvents7d: { rows: [{ n: 0 }] },
    ...overrides,
  };
}

test('every metric the brief reads has a query, and every query is read-only', () => {
  const keys = Object.keys(realisticMetrics());
  assert.deepEqual(Object.keys(QUERIES).sort(), keys.sort());
  for (const [name, q] of Object.entries(QUERIES)) {
    assert.match(q.sql.trim(), /^SELECT\b/i, `${name} must be a SELECT`);
    assert.doesNotMatch(q.sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT)\b/i, name);
  }
});

test('brief covers all three lanes and routes work to the right person', () => {
  const brief = buildBrief(realisticMetrics(), { now: NOW, dailyCap: 20, trigger: 'test' });
  assert.equal(brief.date, '2026-11-23');
  assert.ok(brief.ownerActions.length <= 3, 'at most three things for the owner');
  const lanes = new Set(brief.actions.map(a => a.lane));
  for (const lane of ['wellness', 'beauty', 'buildpipeline']) assert.ok(lanes.has(lane), `${lane} has an action`);
  const roleIds = new Set(ROLES.map(r => r.id));
  for (const a of brief.actions) {
    assert.ok(roleIds.has(a.role), `known role ${a.role}`);
    assert.ok(['owner', 'claude', 'agent'].includes(a.who));
  }
  // Facts from the data, not invented:
  assert.match(brief.markdown, /0 replies from 176 contacted clinics/);
  assert.match(brief.markdown, /533 clinics fail "first touch: eligibility"/);
  assert.match(brief.markdown, /down 57% week over week/);
  assert.match(brief.markdown, /nothing from Lion Elite Beauty reaches the OS/);
  assert.match(brief.markdown, /did not tick in the last 24 hours/);
  // Deferrals are not reported as rejections.
  assert.doesNotMatch(brief.markdown, /fail "run time budget/);
});

test('a failed query shows "no data", never a zero', () => {
  const brief = buildBrief(realisticMetrics({ storeOrders: { error: '42501' }, clinicFunnel: { error: 'permission denied' } }), { now: NOW });
  assert.match(brief.markdown, /Store orders: yesterday no data/);
  assert.match(brief.markdown, /Clinic pipeline: no data/);
  assert.match(brief.markdown, /Revenue: no data/);
  assert.ok(brief.blockers.some(b => /storeOrders \(42501\)/.test(b)));
  assert.ok(!brief.actions.some(a => /Store revenue/.test(a.title)), 'no revenue action without revenue data');
});

test('good news changes the brief: replies and new leads go to the owner first', () => {
  const brief = buildBrief(realisticMetrics({
    clinicReplies: { rows: [{ total: 3, last7: 3 }] },
    capturedLeads: { rows: [{ lane: 'beauty-coaching', total: 5, last7: 4 }] },
    coachingClients: { rows: [{ status: 'active', n: 2 }] },
    funnelEvents7d: { rows: [{ n: 40 }] },
    funnelLeads: { rows: [{ total: 2, last7: 2 }] },
  }), { now: NOW });
  const titles = brief.ownerActions.map(a => a.title).join(' | ');
  assert.match(titles, /Book calls with 2 new applicants/);
  assert.match(titles, /Answer 3 clinics that replied/);
  assert.match(titles, /Follow up 4 new coaching leads/);
  assert.ok(!brief.actions.some(a => /Connect coaching lead capture/.test(a.title)));
  assert.ok(!brief.actions.some(a => /0 replies from/.test(a.title)));
});

test('a paused pipeline is surfaced, and throughput is not blamed while paused', () => {
  const brief = buildBrief(realisticMetrics({ outreachPaused: { rows: [{ value: { paused: true, at: '2026-11-20T10:00:00Z' } }] }, sendsByDay: { rows: [] } }), { now: NOW, dailyCap: 100 });
  assert.match(brief.markdown, /Clinic outreach is paused/);
  assert.ok(!brief.actions.some(a => /throughput/.test(a.title)));
});

test('lead lanes map to businesses', () => {
  assert.equal(laneOfLead('beauty'), 'beauty');
  assert.equal(laneOfLead('coaching-application'), 'beauty');
  assert.equal(laneOfLead('buildpipeline'), 'buildpipeline');
  assert.equal(laneOfLead('wellness_reorder'), 'wellness');
  assert.equal(laneOfLead(null), 'unknown');
});

async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}
const quiet = { log() {}, warn() {}, error() {} };
const rejectingOidc = { verify: async () => { throw Object.assign(new Error('bad'), { code: 'OIDC_BAD_SIGNATURE' }); } };
function memoryStore() {
  const rows = [];
  return { rows, save: async ({ brief }) => { rows.push(brief); }, latest: async () => (rows.length ? { date: rows.at(-1).date, generated_at: rows.at(-1).generatedAt, trigger: rows.at(-1).trigger, markdown: rows.at(-1).markdown } : null) };
}

test('/run/agents/daily-brief: closed without credentials, even with no secret configured', async () => {
  for (const env of [{ OUTREACH_SECRET: 'brief-secret' }, {}]) {
    const store = memoryStore();
    let collected = 0;
    const { base, close } = await serve(createAgentBriefRouter({ env, store, collect: async () => { collected += 1; return realisticMetrics(); }, oidcVerifier: rejectingOidc, database: { query: async () => ({ rows: [] }) }, logger: quiet }));
    try {
      assert.equal((await fetch(`${base}/run/agents/daily-brief`, { method: 'POST' })).status, 401);
      assert.equal((await fetch(`${base}/run/agents/daily-brief`, { method: 'POST', headers: { 'x-outreach-secret': 'wrong' } })).status, 401);
      assert.equal((await fetch(`${base}/run/agents/daily-brief`, { method: 'POST', headers: { authorization: 'Bearer forged' } })).status, 401);
      assert.equal((await fetch(`${base}/run/agents/daily-brief/latest`)).status, 401);
      assert.equal(collected, 0);
    } finally { await close(); }
  }
});

test('/run/agents/daily-brief: builds, stores and returns the brief; latest reads it back', async () => {
  const store = memoryStore();
  const { base, close } = await serve(createAgentBriefRouter({ env: { OUTREACH_SECRET: 'brief-secret' }, store, collect: async () => realisticMetrics(), oidcVerifier: rejectingOidc, logger: quiet, now: () => NOW }));
  const h = { 'x-outreach-secret': 'brief-secret' };
  try {
    const res = await fetch(`${base}/run/agents/daily-brief`, { method: 'POST', headers: h });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.date, '2026-11-23');
    assert.equal(body.stored, true);
    assert.match(body.markdown, /^---\ntype: brief/);
    assert.equal(store.rows.length, 1);
    const latest = await (await fetch(`${base}/run/agents/daily-brief/latest`, { headers: h })).json();
    assert.equal(latest.date, '2026-11-23');
    assert.equal(latest.markdown, body.markdown);
    const async = await fetch(`${base}/run/agents/daily-brief?async=1`, { method: 'POST', headers: h });
    assert.equal(async.status, 202);
  } finally { await close(); }
});

test('/run/agents/daily-brief: the scheduler uses its own credential, not the sender\'s', async () => {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update('brief-vault-secret').digest('hex');
  const seen = [];
  const database = { query: async (sql, params) => { seen.push([sql, params]); return /FROM scheduler_credentials/.test(sql) && params && params[0] === 'agent-daily-brief' ? { rows: [{ v: hash }] } : { rows: [] }; } };
  const store = memoryStore();
  const { base, close } = await serve(createAgentBriefRouter({ env: {}, database, store, collect: async () => realisticMetrics(), oidcVerifier: rejectingOidc, logger: quiet }));
  try {
    const res = await fetch(`${base}/run/agents/daily-brief?async=1`, { method: 'POST', headers: { 'x-outreach-secret': 'brief-vault-secret' } });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { status: 'accepted', trigger: 'supabase/pg_cron' });
    assert.ok(seen.some(([, p]) => p && p[0] === 'agent-daily-brief'));
  } finally { await close(); }
});

test('a brief that cannot be stored is still returned, and says so', async () => {
  const store = { save: async () => { throw new Error('no table'); }, latest: async () => null };
  const { base, close } = await serve(createAgentBriefRouter({ env: { OUTREACH_SECRET: 's' }, store, collect: async () => realisticMetrics(), oidcVerifier: rejectingOidc, logger: quiet }));
  try {
    const body = await (await fetch(`${base}/run/agents/daily-brief`, { method: 'POST', headers: { 'x-outreach-secret': 's' } })).json();
    assert.equal(body.stored, false);
    assert.ok(body.markdown.length > 100);
  } finally { await close(); }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { createGtmFunnelsRouter, createRateLimiter, verifyCalendlySignature, clientKey } = require('../routes/gtm-funnels');
const { MemoryFunnelStore } = require('../lib/platform/funnel-store');

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const SIGNING_KEY = 'test-calendly-signing-key';

async function startApp({ env = { NODE_ENV: 'test', GTM_CALENDLY_WEBHOOK_SIGNING_KEY: SIGNING_KEY }, rateLimiter } = {}) {
  const store = new MemoryFunnelStore();
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/gtm-funnels', createGtmFunnelsRouter({ store, env, rateLimiter: rateLimiter || createRateLimiter({ max: 1000 }) }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/gtm-funnels`;
  const call = async (method, path, body, headers = {}) => {
    const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: raw });
    return { status: res.status, body: await res.json() };
  };
  return { store, call, close: () => new Promise(r => server.close(r)) };
}

const publish = (call, slug = 'acme', over = {}) =>
  call('PUT', `/workspaces/${WS}/funnels/${slug}`, {
    status: 'published',
    config: { calendarUrl: 'https://calendly.com/acme/strategy', ...over },
  });

const leadBody = (over = {}) => ({
  sessionId: 'sess_route_0001',
  name: 'Dana Example',
  email: 'dana@example.com',
  phone: '+13055550100',
  answers: ['Example Roofing', 'Follow-up', '10', '$50k'],
  ...over,
});

test('the full Traffic → VSL → Application → Booking → Confirmation → Follow-up path', async t => {
  const app = await startApp();
  t.after(app.close);
  assert.equal((await publish(app.call)).status, 200);

  const cfg = await app.call('GET', '/public/acme');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.funnel.calendarUrl, 'https://calendly.com/acme/strategy');
  assert.equal(cfg.body.funnel.workspaceId, undefined);

  const sessionId = 'sess_route_0001';
  for (const event of ['page_view', 'video_play', 'cta_revealed', 'cta_click']) {
    const r = await app.call('POST', '/public/acme/events', { event, sessionId });
    assert.equal(r.status, 201, event);
  }
  const dup = await app.call('POST', '/public/acme/events', { event: 'page_view', sessionId });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);

  const lead = await app.call('POST', '/public/acme/leads', leadBody({ smsConsent: true, consentText: 'I agree to texts' }));
  assert.equal(lead.status, 201);
  assert.equal(lead.body.prospectId, undefined, 'prospect id stays internal');
  const prospect = [...app.store.prospects.values()][0];
  assert.equal(prospect.status, 'qualified');
  assert.equal(prospect.email, 'dana@example.com');
  assert.equal(app.store.evidence.length, 4);

  const click = await app.call('POST', '/public/acme/events', { event: 'booking_click', sessionId });
  assert.equal(click.body.crm.meetingStatus, 'proposed');
  assert.equal([...app.store.meetings.values()][0].status, 'proposed');

  const confirm = await app.call('POST', `/workspaces/${WS}/funnels/acme/bookings/confirm`, { sessionId, startsAt: new Date(Date.now() + 3 * 86400e3).toISOString() });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.duplicate, false);
  assert.equal(confirm.body.tasksCancelled, 1, 'the unbooked-calendar rescue is cancelled once booked');
  assert.ok(app.store.tasks.filter(x => x.output.cancelIf === 'booking_confirmed').every(x => x.status === 'cancelled'));
  assert.equal([...app.store.meetings.values()][0].status, 'booked');
  assert.equal(prospect.status, 'meeting');
  assert.equal(app.store.opportunities.get(prospect.prospectId).stage, 'meeting');
  assert.ok(app.store.tasks.every(x => x.output.delivery === 'draft_only'));
  assert.ok(app.store.tasks.some(x => x.output.channel === 'sms'), 'consented lead gets SMS drafts');

  const again = await app.call('POST', `/workspaces/${WS}/funnels/acme/bookings/confirm`, { sessionId });
  assert.equal(again.body.duplicate, true);

  const report = await app.call('GET', `/workspaces/${WS}/funnels/acme/report`);
  const steps = Object.fromEntries(report.body.report.steps.map(s => [s.step, s.sessions]));
  assert.deepEqual(steps, { traffic: 1, vsl: 1, application: 1, booking: 1, confirmation: 1, follow_up: 1 });

  // No analytics row carries identity.
  assert.doesNotMatch(JSON.stringify(app.store.events), /dana@example\.com|3055550100|Dana Example/);
});

test('draft funnels are not public, and a click without an application touches no CRM row', async t => {
  const app = await startApp();
  t.after(app.close);
  await app.call('PUT', `/workspaces/${WS}/funnels/draft-one`, { status: 'draft', config: {} });
  assert.equal((await app.call('GET', '/public/draft-one')).status, 404);
  await publish(app.call);
  const r = await app.call('POST', '/public/acme/events', { event: 'booking_click', sessionId: 'sess_anon_0001' });
  assert.equal(r.status, 201);
  assert.equal(r.body.crm, null);
  assert.equal(app.store.meetings.size, 0);
});

test('a browser cannot self-report a confirmed booking', async t => {
  const app = await startApp();
  t.after(app.close);
  await publish(app.call);
  const r = await app.call('POST', '/public/acme/events', { event: 'booking_confirmed', sessionId: 'sess_route_0001' });
  assert.equal(r.status, 403);
});

test('publishing with the placeholder calendar is refused', async t => {
  const app = await startApp();
  t.after(app.close);
  const r = await publish(app.call, 'acme', { calendarUrl: 'https://calendly.com/' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'CALENDAR_REQUIRED');
});

test('a slug owned by one workspace cannot be taken over by another', async t => {
  const app = await startApp();
  t.after(app.close);
  await publish(app.call);
  const r = await app.call('PUT', `/workspaces/${OTHER_WS}/funnels/acme`, { status: 'draft', config: {} });
  assert.equal(r.status, 409);
  assert.equal((await app.call('GET', `/workspaces/${OTHER_WS}/funnels/acme/report`)).status, 404);
});

test('workspace routes fail closed in production when no auth store exists', async t => {
  const app = await startApp({ env: { NODE_ENV: 'production' } });
  t.after(app.close);
  assert.equal((await publish(app.call)).status, 503);
  assert.equal((await app.call('GET', `/workspaces/${WS}/funnels`)).status, 503);
});

test('Calendly webhook: unsigned is refused, signed invitee.created confirms the booking', async t => {
  const app = await startApp();
  t.after(app.close);
  await publish(app.call);
  await app.call('POST', '/public/acme/leads', leadBody());
  const body = JSON.stringify({
    event: 'invitee.created',
    payload: {
      uri: 'https://api.calendly.com/scheduled_events/E1/invitees/I1',
      tracking: { utm_content: 'sess_route_0001' },
      scheduled_event: { start_time: new Date(Date.now() + 2 * 86400e3).toISOString() },
    },
  });
  assert.equal((await app.call('POST', '/public/acme/calendly-webhook', body)).status, 401);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SIGNING_KEY).update(`${ts}.${body}`).digest('hex');
  const r = await app.call('POST', '/public/acme/calendly-webhook', body, { 'calendly-webhook-signature': `t=${ts},v1=${sig}` });
  assert.equal(r.status, 200);
  assert.equal(r.body.matched, true);
  assert.equal([...app.store.meetings.values()][0].status, 'booked');
  assert.equal([...app.store.meetings.values()][0].externalCalendarId, 'https://api.calendly.com/scheduled_events/E1/invitees/I1');
});

test('Calendly webhook is disabled without a signing key', async t => {
  const app = await startApp({ env: { NODE_ENV: 'test' } });
  t.after(app.close);
  assert.equal((await app.call('POST', '/public/acme/calendly-webhook', { event: 'invitee.created' })).status, 503);
});

test('Calendly signature check rejects stale timestamps and tampering', () => {
  const raw = Buffer.from('{"a":1}');
  const ts = 1_800_000_000;
  const sig = crypto.createHmac('sha256', 'k').update(`${ts}.${raw}`).digest('hex');
  assert.equal(verifyCalendlySignature({ header: `t=${ts},v1=${sig}`, rawBody: raw, signingKey: 'k', now: ts }), true);
  assert.equal(verifyCalendlySignature({ header: `t=${ts},v1=${sig}`, rawBody: raw, signingKey: 'k', now: ts + 1000 }), false);
  assert.equal(verifyCalendlySignature({ header: `t=${ts},v1=${sig}`, rawBody: Buffer.from('{"a":2}'), signingKey: 'k', now: ts }), false);
});

test('public endpoints are rate limited', async t => {
  const app = await startApp({ rateLimiter: createRateLimiter({ max: 2 }) });
  t.after(app.close);
  await publish(app.call);
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await app.call('GET', '/public/acme')).status);
  assert.deepEqual(statuses, [200, 200, 429]);
});

test('forwarded visitor IP is trusted only with the proxy secret', () => {
  const env = { BUILDPIPELINE_PROXY_SECRET: 'proxy-secret-value' };
  const req = headers => ({ ip: '10.0.0.1', headers });
  assert.equal(clientKey(req({ 'x-buildpipeline-client-ip': '203.0.113.9' }), env), '10.0.0.1');
  assert.equal(clientKey(req({ 'x-buildpipeline-client-ip': '203.0.113.9', 'x-buildpipeline-proxy-secret': 'wrong-secret-valu' }), env), '10.0.0.1');
  assert.equal(clientKey(req({ 'x-buildpipeline-client-ip': '203.0.113.9, 10.0.0.2', 'x-buildpipeline-proxy-secret': 'proxy-secret-value' }), env), 'fwd:203.0.113.9');
  assert.equal(clientKey(req({ 'x-buildpipeline-client-ip': '203.0.113.9', 'x-buildpipeline-proxy-secret': 'proxy-secret-value' }), {}), '10.0.0.1');
});

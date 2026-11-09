'use strict';

/**
 * Runs PostgresFunnelStore against the real schema. CI provisions Postgres
 * (ci-render.yml), so this executes there; locally it skips without
 * DATABASE_URL. Source-text guards alone are how `audit_events` shipped broken.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('Postgres funnel lifecycle writes through to the GTM CRM tables', { skip: !databaseConfigured }, async t => {
  const { migrate, query, close } = require('../lib/database');
  const { PostgresFunnelStore } = require('../lib/platform/funnel-store');
  const { validateLead, buildClientEvent } = require('../lib/platform/vsl-funnel');
  const { holdExclusiveDb } = require('./helpers/db-exclusive');
  const release = await holdExclusiveDb();
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
    await release();
    await close();
  });
  await migrate();

  const ws = await query(`INSERT INTO gtm_workspaces (name, slug) VALUES ('Funnel CI', 'funnel-ci-' || substr(md5(random()::text),1,8)) RETURNING workspace_id`);
  const workspaceId = ws.rows[0].workspace_id;
  cleanup.push(() => query('DELETE FROM gtm_workspaces WHERE workspace_id=$1', [workspaceId]));

  const store = new PostgresFunnelStore();
  const slug = 'ci-' + Math.random().toString(36).slice(2, 10);
  const funnel = await store.saveFunnel(workspaceId, { slug, status: 'published', config: { calendarUrl: 'https://calendly.com/ci/strategy' } });
  assert.equal((await store.getPublishedFunnel(slug)).funnelId, funnel.funnelId);

  const other = await query(`INSERT INTO gtm_workspaces (name, slug) VALUES ('Other', 'other-' || substr(md5(random()::text),1,8)) RETURNING workspace_id`);
  cleanup.push(() => query('DELETE FROM gtm_workspaces WHERE workspace_id=$1', [other.rows[0].workspace_id]));
  await assert.rejects(store.saveFunnel(other.rows[0].workspace_id, { slug, status: 'draft' }), e => e.code === 'SLUG_TAKEN');

  const sessionId = 'sess_ci_00000001';
  for (const type of ['page_view', 'video_play', 'cta_click']) {
    assert.equal((await store.recordClientEvent(funnel, buildClientEvent({ event: type, sessionId }))).recorded, true);
  }
  assert.equal((await store.recordClientEvent(funnel, buildClientEvent({ event: 'page_view', sessionId }))).duplicate, true);

  const lead = validateLead({
    sessionId, name: 'CI Person', email: 'ci@example.com', phone: '+13055550100',
    answers: ['CI Co', 'Growth', '5', '$20k'], smsConsent: true, consentText: 'I agree',
  }, funnel.config.qualificationQuestions);
  const captured = await store.captureLead(funnel, lead);
  assert.equal(captured.duplicate, false);
  assert.equal((await store.captureLead(funnel, lead)).duplicate, true);

  const click = await store.recordClientEvent(funnel, buildClientEvent({ event: 'booking_click', sessionId }));
  assert.equal(click.crm.meetingStatus, 'proposed');

  const startsAt = new Date(Date.now() + 3 * 86400e3).toISOString();
  const confirmed = await store.confirmBooking(funnel, { sessionId, startsAt, externalCalendarId: 'cal-1' });
  assert.equal(confirmed.duplicate, false);
  assert.equal(confirmed.tasksCancelled, 1, 'the unbooked-calendar rescue is cancelled once booked');
  assert.equal((await store.confirmBooking(funnel, { sessionId })).duplicate, true);

  const p = await query('SELECT status, email FROM gtm_prospects WHERE prospect_id=$1', [captured.prospectId]);
  assert.equal(p.rows[0].status, 'meeting');
  const m = await query('SELECT status, external_calendar_id FROM gtm_meetings WHERE prospect_id=$1', [captured.prospectId]);
  assert.equal(m.rowCount, 1, 'the proposed meeting is promoted, not duplicated');
  assert.equal(m.rows[0].status, 'booked');
  const o = await query('SELECT stage FROM gtm_opportunities WHERE prospect_id=$1', [captured.prospectId]);
  assert.equal(o.rows[0].stage, 'meeting');
  const ev = await query('SELECT count(*)::int AS n FROM gtm_evidence WHERE prospect_id=$1', [captured.prospectId]);
  assert.equal(ev.rows[0].n, 4);
  const consent = await query('SELECT sms_consent, sms_consent_text, sms_consent_at FROM gtm_funnel_leads WHERE prospect_id=$1', [captured.prospectId]);
  assert.equal(consent.rows[0].sms_consent, true);
  assert.ok(consent.rows[0].sms_consent_at);
  const tasks = await query(`SELECT output FROM gtm_agent_tasks WHERE workspace_id=$1 AND delegated_by='vsl-funnel'`, [workspaceId]);
  assert.ok(tasks.rowCount > 0);
  assert.ok(tasks.rows.every(r => r.output.delivery === 'draft_only'));

  const rows = await query('SELECT metadata FROM gtm_funnel_events WHERE funnel_id=$1', [funnel.funnelId]);
  assert.doesNotMatch(JSON.stringify(rows.rows), /ci@example\.com|CI Person/);

  const report = await store.report(funnel);
  const steps = Object.fromEntries(report.steps.map(s => [s.step, s.sessions]));
  assert.deepEqual(steps, { traffic: 1, vsl: 1, application: 1, booking: 1, confirmation: 1, follow_up: 1 });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const f = require('../lib/platform/vsl-funnel');
const { DEFAULT_GTM_AGENTS } = require('../lib/platform/default-gtm-agents');

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const tableBlock = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  assert.notEqual(start, -1, `db/schema.sql must define ${name}`);
  const rest = schema.slice(start);
  return rest.slice(0, rest.indexOf('\n);'));
};
const checkValues = (table, column) => {
  const m = tableBlock(table).match(new RegExp(`\\b${column}\\b[^\\n]*CHECK \\(${column} IN \\(([^)]*)\\)`));
  assert.ok(m, `${table}.${column} must carry a CHECK list`);
  return m[1].split(',').map(x => x.trim().replace(/'/g, ''));
};

const lead = (over = {}) => ({
  sessionId: 'sess_abcdefgh',
  name: 'Dana Example',
  email: 'Dana@Example.com',
  phone: '+1 (305) 555-0100',
  answers: ['Example Roofing', 'Lead follow-up', '12', '$80k'],
  ...over,
});

test('funnel steps are exactly the six README stages, in order', () => {
  assert.deepEqual(f.FUNNEL_STEPS, ['traffic', 'vsl', 'application', 'booking', 'confirmation', 'follow_up']);
  for (const step of f.FUNNEL_STEPS) assert.ok(Object.values(f.EVENT_STEPS).includes(step), `${step} has an event`);
});

test('schema CHECK lists match the closed event and step vocabularies', () => {
  assert.deepEqual(checkValues('gtm_funnel_events', 'event_type').sort(), [...f.EVENT_TYPES].sort());
  assert.deepEqual(checkValues('gtm_funnel_events', 'step').sort(), [...f.FUNNEL_STEPS].sort());
  assert.deepEqual(checkValues('gtm_funnels', 'status').sort(), [...f.FUNNEL_STATUSES].sort());
});

test('CRM transitions only use values the GTM schema accepts', () => {
  const prospect = checkValues('gtm_prospects', 'status');
  const meeting = checkValues('gtm_meetings', 'status');
  const opp = checkValues('gtm_opportunities', 'stage');
  for (const [type, t] of Object.entries(f.CRM_TRANSITIONS)) {
    assert.ok(prospect.includes(t.prospectStatus), `${type} prospect status`);
    if (t.meetingStatus) assert.ok(meeting.includes(t.meetingStatus), `${type} meeting status`);
    if (t.opportunityStage) assert.ok(opp.includes(t.opportunityStage), `${type} opportunity stage`);
  }
});

test('a calendar click is a proposed meeting; only confirmation books it', () => {
  assert.equal(f.crmTransition('booking_click').meetingStatus, 'proposed');
  assert.equal(f.crmTransition('booking_confirmed').meetingStatus, 'booked');
  assert.equal(f.crmTransition('booking_confirmed').prospectStatus, 'meeting');
});

test('browsers cannot report server-side lifecycle events', () => {
  for (const type of ['booking_confirmed', 'lead_qualified', 'follow_up_planned']) {
    assert.throws(() => f.buildClientEvent({ event: type, sessionId: 'sess_abcdefgh' }), e => e.status === 403 || e.code === 'SERVER_ONLY_EVENT');
  }
  assert.throws(() => f.buildClientEvent({ event: 'page_veiw', sessionId: 'sess_abcdefgh' }), /unknown funnel event/);
});

test('client events keep only allowlisted, PII-free metadata', () => {
  const ev = f.buildClientEvent({
    event: 'page_view',
    sessionId: 'sess_abcdefgh',
    email: 'x@y.com',
    lead: { phone: '555' },
    utm: { source: 'meta', campaign: 'oct' },
    referrer: 'https://news.example/path?email=x@y.com',
  });
  assert.equal(ev.step, 'traffic');
  assert.deepEqual(ev.metadata, { utm_source: 'meta', utm_campaign: 'oct', referrer_host: 'news.example' });
  assert.doesNotMatch(JSON.stringify(ev), /x@y\.com|555/);
});

test('event keys are idempotent per session', () => {
  const a = f.buildClientEvent({ event: 'cta_click', sessionId: 'sess_abcdefgh' });
  const b = f.buildClientEvent({ event: 'cta_click', sessionId: 'sess_abcdefgh' });
  const c = f.buildClientEvent({ event: 'cta_click', sessionId: 'sess_zzzzzzzz' });
  assert.equal(a.eventKey, b.eventKey);
  assert.notEqual(a.eventKey, c.eventKey);
});

test('config: https-only URLs, bounded fields, defaults fill gaps', () => {
  const c = f.normalizeFunnelConfig({});
  assert.equal(c.headline, f.DEFAULT_CONFIG.headline);
  assert.throws(() => f.normalizeFunnelConfig({ calendarUrl: 'javascript:alert(1)' }), /https|valid URL/);
  assert.throws(() => f.normalizeFunnelConfig({ videoUrl: 'http://v.example/x.mp4' }), /https/);
  assert.throws(() => f.normalizeFunnelConfig({ ctaRevealSeconds: -1 }), /ctaRevealSeconds/);
  assert.throws(() => f.normalizeFunnelConfig({ qualificationQuestions: Array(9).fill('q') }), /at most 8/);
});

test('publishing requires a specific scheduling page, not the prototype placeholder', () => {
  assert.throws(() => f.normalizeFunnelConfig({ calendarUrl: 'https://calendly.com/' }, { status: 'published' }), e => e.code === 'CALENDAR_REQUIRED');
  assert.throws(() => f.normalizeFunnelConfig({}, { status: 'published' }), e => e.code === 'CALENDAR_REQUIRED');
  const ok = f.normalizeFunnelConfig({ calendarUrl: 'https://calendly.com/acme/strategy' }, { status: 'published' });
  assert.equal(ok.calendarUrl, 'https://calendly.com/acme/strategy');
  // Drafts may be incomplete.
  assert.doesNotThrow(() => f.normalizeFunnelConfig({ calendarUrl: 'https://calendly.com/' }));
});

test('video URLs from the promised hosts become embeds', () => {
  assert.equal(f.videoEmbed('https://www.youtube.com/watch?v=abc123').src, 'https://www.youtube-nocookie.com/embed/abc123');
  assert.equal(f.videoEmbed('https://youtu.be/abc123').kind, 'iframe');
  assert.equal(f.videoEmbed('https://vimeo.com/76979871').src, 'https://player.vimeo.com/video/76979871');
  assert.equal(f.videoEmbed('https://fast.wistia.net/embed/iframe/xyz').kind, 'iframe');
  assert.equal(f.videoEmbed('https://cdn.example/vsl.mp4').kind, 'file');
  assert.equal(f.videoEmbed('').kind, 'none');
});

test('public view exposes no workspace identifiers', () => {
  const view = f.publicFunnelView({ funnelId: 'fid', workspaceId: 'wid', campaignId: 'cid', slug: 'demo', config: f.normalizeFunnelConfig({}) });
  assert.equal(view.slug, 'demo');
  assert.doesNotMatch(JSON.stringify(view), /fid|wid|cid/);
});

test('lead validation: answers per question, email/phone sanity, honeypot', () => {
  const q = f.DEFAULT_CONFIG.qualificationQuestions;
  const v = f.validateLead(lead(), q);
  assert.equal(v.email, 'dana@example.com');
  assert.equal(v.companyName, 'Example Roofing');
  assert.equal(v.answers.length, q.length);
  assert.equal(v.smsConsent, false);
  assert.throws(() => f.validateLead(lead({ answers: ['only one'] }), q), e => e.code === 'INCOMPLETE_ANSWERS');
  assert.throws(() => f.validateLead(lead({ email: 'nope' }), q), /email/);
  assert.throws(() => f.validateLead(lead({ phone: '12' }), q), /phone/);
  assert.throws(() => f.validateLead(lead({ website: 'http://spam' }), q), e => e.code === 'HONEYPOT');
  // The prototype's {0: 'a', 1: 'b'} answer object shape is accepted too.
  assert.equal(f.validateLead(lead({ answers: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' } }), q).answers[3].answer, 'D');
});

test('SMS consent counts only as an explicit boolean true', () => {
  const q = f.DEFAULT_CONFIG.qualificationQuestions;
  for (const v of ['true', 1, 'yes', undefined]) assert.equal(f.validateLead(lead({ smsConsent: v }), q).smsConsent, false);
  assert.equal(f.validateLead(lead({ smsConsent: true, consentText: 'I agree' }), q).smsConsent, true);
});

test('follow-up is draft_only, uses real agent keys, and SMS needs consent', () => {
  const agentKeys = DEFAULT_GTM_AGENTS.map(a => a.key);
  const now = new Date('2026-11-06T12:00:00Z');
  const meeting = { startsAt: '2026-11-08T15:00:00Z' };
  const noConsent = f.planFollowUps('booking_confirmed', { lead: { smsConsent: false }, meeting, now });
  const consent = f.planFollowUps('booking_confirmed', { lead: { smsConsent: true }, meeting, now });
  for (const t of [...noConsent, ...consent, ...f.planFollowUps('lead_qualified', { now }), ...f.planFollowUps('booking_click', { now })]) {
    assert.equal(t.delivery, 'draft_only');
    assert.ok(agentKeys.includes(t.agentKey), `${t.agentKey} is a provisioned agent`);
  }
  assert.equal(noConsent.filter(t => t.channel === 'sms').length, 0);
  assert.ok(consent.filter(t => t.channel === 'sms').length >= 1);
  assert.ok(noConsent.some(t => /24 hours/.test(t.objective)) && noConsent.some(t => /1 hour/.test(t.objective)));
});

test('reminders already in the past are not planned', () => {
  const now = new Date('2026-11-08T14:30:00Z');
  const tasks = f.planFollowUps('booking_confirmed', { lead: {}, meeting: { startsAt: '2026-11-08T15:00:00Z' }, now });
  assert.ok(!tasks.some(t => /reminder/.test(t.objective)));
});

test('report counts unique sessions per step and surfaces the click→confirmed gap', () => {
  const ev = (type, s) => ({ type, sessionId: s });
  const r = f.funnelReport([
    ev('page_view', 'a'), ev('page_view', 'b'), ev('page_view', 'c'), ev('page_view', 'a'),
    ev('video_play', 'a'), ev('cta_revealed', 'a'), ev('cta_revealed', 'b'),
    ev('cta_click', 'a'), ev('lead_qualified', 'a'),
    ev('booking_click', 'a'),
  ]);
  const step = s => r.steps.find(x => x.step === s);
  assert.equal(step('traffic').sessions, 3);
  assert.equal(step('vsl').sessions, 2);
  assert.equal(step('application').sessions, 1);
  assert.equal(step('confirmation').sessions, 0);
  assert.equal(r.bookingClickToConfirmed, 0);
  assert.match(r.note, /not bookings/);
});

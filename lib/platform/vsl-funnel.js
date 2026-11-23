'use strict';

/**
 * BuildPipeline VSL funnel domain model.
 *
 * apps/buildpipeline/README.md set out the vision for the funnel engine:
 *
 *   Traffic → VSL → Application → Booking → Confirmation → Follow-up
 *
 * plus four integration targets — a funnel config model instead of the
 * hard-coded `demoFunnel`, funnel events persisted to an analytics store instead
 * of `console.log`, a real calendar instead of `https://calendly.com/`, and
 * `lead_qualified` / `booking_click` hooked into CRM stages and follow-up
 * automation. This module is the pure half of that: the taxonomy, validation,
 * CRM mapping, follow-up plan and conversion report. Persistence lives in
 * lib/platform/funnel-store.js, HTTP in routes/gtm-funnels.js.
 *
 * Four rules, each fixing something the prototype got wrong:
 *
 * 1. The event list is CLOSED. An unknown event type throws. A typo that
 *    silently becomes a new funnel step produces a report that looks fine and is
 *    wrong (same rule as lib/revenue/funnel-events.js).
 * 2. Analytics events carry NO PII. The prototype posted the lead's name, e-mail,
 *    phone and every qualification answer inside the `lead_qualified` analytics
 *    event and logged it to stdout. Lead identity now travels on its own path
 *    into the CRM (gtm_prospects); the event row references the prospect by id.
 * 3. A click is not a booking. The prototype showed "✓ Funnel conversion
 *    recorded" the moment someone clicked "Open Calendar". `booking_click` maps to
 *    a *proposed* meeting; only `booking_confirmed` (the calendar provider, or an
 *    operator, saying a slot was actually taken) marks it booked. Otherwise the
 *    funnel reports the number most flattering to whoever built it.
 * 4. Follow-up is PLANNED, never sent. This module has no send capability. It
 *    emits agent tasks in `draft_only` mode, and SMS steps appear only when the
 *    lead gave explicit SMS consent on the form (TCPA prior express written
 *    consent — see CLAUDE.md hard limits). Actually sending stays behind the
 *    workspace's sender policy and a human-controlled switch.
 */

const crypto = require('crypto');

class FunnelError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'FunnelError';
    this.code = code;
    this.status = status;
  }
}

/** The six stages from the README, in order. Order drives the conversion walk. */
const FUNNEL_STEPS = Object.freeze(['traffic', 'vsl', 'application', 'booking', 'confirmation', 'follow_up']);

/**
 * Closed event vocabulary → the step each event evidences. Several events can
 * evidence one step; the report counts unique sessions per step, so a visitor
 * who both reveals and clicks the CTA is still one visitor.
 */
const EVENT_STEPS = Object.freeze({
  page_view: 'traffic',
  video_play: 'vsl',
  cta_revealed: 'vsl',
  cta_click: 'application',
  lead_qualified: 'application',
  booking_click: 'booking',
  booking_confirmed: 'confirmation',
  follow_up_planned: 'follow_up',
});
const EVENT_TYPES = Object.freeze(Object.keys(EVENT_STEPS));

/**
 * Events a browser may report. The last two are server-side facts: a browser
 * claiming "booking_confirmed" is exactly the self-reported conversion rule 3
 * exists to stop, and follow-up planning is something the store does itself.
 */
const CLIENT_EVENT_TYPES = Object.freeze(['page_view', 'video_play', 'cta_revealed', 'cta_click', 'booking_click']);

/**
 * CRM effect of each lifecycle event. Values are the CHECK-constrained enums in
 * db/schema.sql (gtm_prospects.status, gtm_meetings.status,
 * gtm_opportunities.stage) — test/vsl-funnel.test.js reconciles them against the
 * schema text so the two cannot drift.
 */
const CRM_TRANSITIONS = Object.freeze({
  lead_qualified: { prospectStatus: 'qualified', meetingStatus: null, opportunityStage: null },
  booking_click: { prospectStatus: 'qualified', meetingStatus: 'proposed', opportunityStage: null },
  booking_confirmed: { prospectStatus: 'meeting', meetingStatus: 'booked', opportunityStage: 'meeting' },
});

const FUNNEL_STATUSES = Object.freeze(['draft', 'published', 'archived']);

const LIMITS = Object.freeze({
  headline: 140,
  subheadline: 400,
  ctaLabel: 40,
  proofItems: 6,
  proofItem: 120,
  questions: 8,
  question: 160,
  answer: 500,
  name: 120,
  phone: 32,
  minRevealSeconds: 0,
  maxRevealSeconds: 900,
});

const DEFAULT_CONFIG = Object.freeze({
  headline: 'Turn More Qualified Prospects Into Booked Sales Calls',
  subheadline:
    'Watch the short presentation to see how BuildPipeline finds, qualifies, nurtures, and books prospects automatically.',
  videoUrl: '',
  ctaRevealSeconds: 8,
  ctaLabel: 'See If You Qualify',
  calendarUrl: '',
  proof: ['Automated lead capture', 'Qualification before booking', 'Email + SMS follow-up ready', 'End-to-end conversion tracking'],
  qualificationQuestions: [
    'What is your company name?',
    'What is your biggest growth bottleneck?',
    'How many qualified sales calls do you book per month?',
    'What is your target monthly revenue?',
  ],
});

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new FunnelError('slug must be 1-48 chars of a-z, 0-9 and inner hyphens', 'INVALID_SLUG');
  return slug;
}

function httpsUrl(value, field, { required = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) throw new FunnelError(`${field} is required`, 'MISSING_URL');
    return '';
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FunnelError(`${field} is not a valid URL`, 'INVALID_URL');
  }
  // https only: these URLs are rendered into a public page and opened in a new
  // tab, so `javascript:`/`data:` would be script injection and http would be a
  // mixed-content downgrade.
  if (url.protocol !== 'https:') throw new FunnelError(`${field} must use https`, 'INVALID_URL');
  return url.toString();
}

/**
 * Generic calendar landing pages are not a booking destination — the prototype
 * shipped `https://calendly.com/`, which sends every qualified lead to Calendly's
 * marketing homepage. A published funnel must point at a specific scheduling page.
 */
function isPlaceholderCalendar(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    const pathOnly = u.pathname.replace(/\/+$/, '');
    return pathOnly === '' && /(^|\.)(calendly\.com|cal\.com|savvycal\.com|tidycal\.com)$/i.test(u.hostname);
  } catch {
    return true;
  }
}

/**
 * Validate and normalize a funnel config. Drafts may be incomplete; publishing
 * requires a real calendar URL — a published funnel with nowhere to book is a
 * lead sink.
 */
function normalizeFunnelConfig(input = {}, { status = 'draft' } = {}) {
  if (!isPlainObject(input)) throw new FunnelError('funnel config must be an object', 'INVALID_CONFIG');
  if (!FUNNEL_STATUSES.includes(status)) throw new FunnelError(`unknown funnel status "${status}"`, 'INVALID_STATUS');

  const pick = (key, max) => text(input[key] !== undefined ? input[key] : DEFAULT_CONFIG[key], max);
  const list = (key, maxItems, maxLen) => {
    const raw = input[key] !== undefined ? input[key] : DEFAULT_CONFIG[key];
    if (!Array.isArray(raw)) throw new FunnelError(`${key} must be an array`, 'INVALID_CONFIG');
    const items = raw.map(x => text(x, maxLen)).filter(Boolean);
    if (items.length > maxItems) throw new FunnelError(`${key} allows at most ${maxItems} items`, 'INVALID_CONFIG');
    return items;
  };

  const reveal = input.ctaRevealSeconds !== undefined ? Number(input.ctaRevealSeconds) : DEFAULT_CONFIG.ctaRevealSeconds;
  if (!Number.isInteger(reveal) || reveal < LIMITS.minRevealSeconds || reveal > LIMITS.maxRevealSeconds) {
    throw new FunnelError(`ctaRevealSeconds must be an integer from ${LIMITS.minRevealSeconds} to ${LIMITS.maxRevealSeconds}`, 'INVALID_CONFIG');
  }

  const config = {
    headline: pick('headline', LIMITS.headline),
    subheadline: pick('subheadline', LIMITS.subheadline),
    videoUrl: httpsUrl(input.videoUrl, 'videoUrl'),
    ctaRevealSeconds: reveal,
    ctaLabel: pick('ctaLabel', LIMITS.ctaLabel),
    calendarUrl: httpsUrl(input.calendarUrl, 'calendarUrl'),
    proof: list('proof', LIMITS.proofItems, LIMITS.proofItem),
    qualificationQuestions: list('qualificationQuestions', LIMITS.questions, LIMITS.question),
  };
  if (!config.headline) throw new FunnelError('headline is required', 'INVALID_CONFIG');
  if (!config.ctaLabel) throw new FunnelError('ctaLabel is required', 'INVALID_CONFIG');

  if (status === 'published' && isPlaceholderCalendar(config.calendarUrl)) {
    throw new FunnelError(
      'a published funnel needs a specific scheduling page in calendarUrl (not empty, not a calendar provider homepage)',
      'CALENDAR_REQUIRED'
    );
  }
  return config;
}

/** Recognise the video hosts the funnel promises, so the page can embed them. */
function videoEmbed(videoUrl) {
  if (!videoUrl) return { kind: 'none', src: '' };
  let u;
  try {
    u = new URL(videoUrl);
  } catch {
    return { kind: 'none', src: '' };
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const id = u.searchParams.get('v') || (u.pathname.startsWith('/embed/') ? u.pathname.split('/')[2] : '');
    if (id) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` };
  }
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (id) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` };
  }
  if (host === 'vimeo.com') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    if (/^\d+$/.test(id || '')) return { kind: 'iframe', src: `https://player.vimeo.com/video/${id}` };
  }
  if (host === 'player.vimeo.com' || host.endsWith('wistia.com') || host.endsWith('wistia.net') || host === 'fast.wistia.net') {
    return { kind: 'iframe', src: u.toString() };
  }
  return { kind: 'file', src: u.toString() };
}

/** The shape a public page is allowed to see. No workspace ids, no internals. */
function publicFunnelView(funnel) {
  return {
    slug: funnel.slug,
    ...funnel.config,
    video: videoEmbed(funnel.config.videoUrl),
  };
}

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Validate a browser-reported analytics event. Only CLIENT_EVENT_TYPES are
 * accepted; metadata is restricted to a small allowlist so the analytics table
 * cannot become a second, unconsented copy of the lead list.
 */
function buildClientEvent(input = {}) {
  if (!isPlainObject(input)) throw new FunnelError('event must be an object', 'INVALID_EVENT');
  const type = String(input.event || input.type || '').trim();
  if (!EVENT_TYPES.includes(type)) {
    throw new FunnelError(`unknown funnel event "${type}" (known: ${EVENT_TYPES.join(', ')})`, 'UNKNOWN_EVENT');
  }
  if (!CLIENT_EVENT_TYPES.includes(type)) {
    throw new FunnelError(`"${type}" is recorded by the server, not reported by a browser`, 'SERVER_ONLY_EVENT', 403);
  }
  const sessionId = String(input.sessionId || '').trim();
  if (!SESSION_RE.test(sessionId)) throw new FunnelError('sessionId must be 8-64 url-safe characters', 'INVALID_SESSION');

  const metadata = {};
  const utm = isPlainObject(input.utm) ? input.utm : {};
  for (const key of ['source', 'medium', 'campaign', 'content', 'term']) {
    const v = text(utm[key], 80);
    if (v) metadata[`utm_${key}`] = v;
  }
  const referrer = text(input.referrer, 200);
  if (referrer) {
    try {
      // Host only — a full referrer URL can carry query-string identity.
      metadata.referrer_host = new URL(referrer).hostname;
    } catch {
      /* ignore an unparseable referrer rather than reject the event */
    }
  }
  return {
    type,
    step: EVENT_STEPS[type],
    sessionId,
    metadata,
    eventKey: eventKey({ type, sessionId, discriminator: input.eventId }),
  };
}

/**
 * Idempotency key. One logical event per (type, session) for once-per-visit
 * events; a browser retry therefore cannot inflate the funnel. Callers may
 * supply a discriminator for events that can legitimately repeat.
 */
function eventKey({ type, sessionId, discriminator = '' }) {
  return crypto.createHash('sha256').update([type, sessionId, String(discriminator || '')].join('|')).digest('hex');
}

/**
 * Validate a lead submission. Identity goes to the CRM, never to the analytics
 * table. SMS consent must be an explicit boolean `true` from an unticked-by-
 * default checkbox; anything else is "no consent".
 */
function validateLead(input = {}, questions = []) {
  if (!isPlainObject(input)) throw new FunnelError('lead must be an object', 'INVALID_LEAD');
  // Honeypot: a hidden field real visitors never fill. Reject quietly upstream.
  if (text(input.website, 200)) throw new FunnelError('rejected', 'HONEYPOT', 400);

  const sessionId = String(input.sessionId || '').trim();
  if (!SESSION_RE.test(sessionId)) throw new FunnelError('sessionId must be 8-64 url-safe characters', 'INVALID_SESSION');

  const name = text(input.name, LIMITS.name);
  const email = text(input.email, 254).toLowerCase();
  const phone = text(input.phone, LIMITS.phone);
  if (!name) throw new FunnelError('name is required', 'INVALID_LEAD');
  if (!EMAIL_RE.test(email)) throw new FunnelError('a valid email is required', 'INVALID_LEAD');
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) throw new FunnelError('a valid phone number is required', 'INVALID_LEAD');

  const rawAnswers = Array.isArray(input.answers)
    ? input.answers
    : isPlainObject(input.answers)
      ? questions.map((_q, i) => input.answers[i])
      : [];
  const answers = questions.map((question, i) => ({ question, answer: text(rawAnswers[i], LIMITS.answer) }));
  const missing = answers.filter(a => !a.answer).map(a => a.question);
  if (missing.length) throw new FunnelError(`unanswered qualification questions: ${missing.join(' | ')}`, 'INCOMPLETE_ANSWERS');

  return {
    sessionId,
    name,
    email,
    phone,
    // Company is conventionally the first question; use it if it looks like one.
    companyName: /company/i.test(questions[0] || '') ? answers[0].answer.slice(0, 160) : '',
    answers,
    smsConsent: input.smsConsent === true,
    consentText: input.smsConsent === true ? text(input.consentText, 500) : '',
  };
}

/**
 * Fit scoring from answers is deliberately crude and transparent: the funnel
 * only knows what the visitor typed. It never DISQUALIFIES (that is a human or
 * campaign-policy decision); it ranks follow-up order.
 */
function scoreLead(lead) {
  let score = 40;
  const joined = lead.answers.map(a => a.answer).join(' ').toLowerCase();
  if (lead.companyName) score += 10;
  if (/\$?\d[\d,.]*\s*(k|m|million|thousand)?/.test(joined)) score += 15;
  if (lead.answers.every(a => a.answer.length >= 3)) score += 15;
  if (lead.answers.some(a => a.answer.length >= 40)) score += 10;
  return Math.max(0, Math.min(100, score));
}

/** Map a lifecycle event to its CRM effect, or throw for an event that has none. */
function crmTransition(type) {
  const t = CRM_TRANSITIONS[type];
  if (!t) throw new FunnelError(`"${type}" has no CRM transition`, 'NO_CRM_TRANSITION');
  return t;
}

const HOUR = 3600 * 1000;

/**
 * Follow-up plan for a lifecycle event — agent tasks, never messages. Every task
 * is `draft_only`: the agent may prepare copy, a human or the workspace's
 * sender policy decides whether it goes. SMS steps require recorded consent.
 */
function planFollowUps(type, { lead = {}, meeting = {}, now = new Date() } = {}) {
  const at = d => new Date(d).toISOString();
  const smsAllowed = lead.smsConsent === true;
  const tasks = [];
  const push = (agentKey, objective, channel, runAfter, extra = {}) =>
    tasks.push({ agentKey, objective, channel, runAfter: at(runAfter), delivery: 'draft_only', ...extra });

  if (type === 'lead_qualified') {
    push('outbound', 'Review the funnel application and prepare a personal booking nudge if no booking within 1 hour', 'email', now.getTime() + HOUR);
    push('outbound', 'Notify the assigned rep that a qualified funnel application arrived', 'internal', now.getTime());
  } else if (type === 'booking_click') {
    // A click with no confirmation within a day is the commonest leak in a VSL
    // funnel: the visitor opened the calendar and never picked a slot.
    push('outbound', 'Calendar opened but no confirmed booking after 24h — prepare a rescue follow-up', 'email', now.getTime() + 24 * HOUR, {
      cancelIf: 'booking_confirmed',
    });
  } else if (type === 'booking_confirmed') {
    push('copy', 'Prepare the booking confirmation message', 'email', now.getTime());
    if (smsAllowed) push('copy', 'Prepare the booking confirmation text', 'sms', now.getTime());
    push('outbound', 'Notify the assigned rep of the confirmed call and attach the application answers', 'internal', now.getTime());
    const startsAt = meeting.startsAt ? new Date(meeting.startsAt).getTime() : NaN;
    if (Number.isFinite(startsAt)) {
      for (const [label, lead_ms] of [
        ['24 hours', 24 * HOUR],
        ['1 hour', HOUR],
      ]) {
        const runAfter = startsAt - lead_ms;
        if (runAfter > now.getTime()) {
          push('copy', `Prepare the ${label} meeting reminder`, 'email', runAfter);
          if (smsAllowed) push('copy', `Prepare the ${label} meeting reminder text`, 'sms', runAfter);
        }
      }
      push('outbound', 'Mark the meeting held or no-show', 'internal', startsAt + HOUR);
    }
  } else {
    throw new FunnelError(`"${type}" has no follow-up plan`, 'NO_FOLLOW_UP');
  }
  return tasks;
}

/**
 * Conversion report over stored events. Counts UNIQUE sessions per step, then
 * walks FUNNEL_STEPS for step-to-step conversion. Reports the click→confirmed
 * gap explicitly because that is the number a VSL funnel most often hides.
 */
function funnelReport(events = []) {
  const sessionsByStep = Object.fromEntries(FUNNEL_STEPS.map(s => [s, new Set()]));
  const sessionsByEvent = Object.fromEntries(EVENT_TYPES.map(e => [e, new Set()]));
  for (const ev of events) {
    const step = EVENT_STEPS[ev.type];
    if (!step) continue;
    sessionsByStep[step].add(ev.sessionId);
    sessionsByEvent[ev.type].add(ev.sessionId);
  }
  const steps = FUNNEL_STEPS.map((step, i) => {
    const count = sessionsByStep[step].size;
    const prev = i === 0 ? null : sessionsByStep[FUNNEL_STEPS[i - 1]].size;
    return {
      step,
      sessions: count,
      conversionFromPrevious: prev === null ? null : prev === 0 ? null : Number((count / prev).toFixed(4)),
    };
  });
  const clicks = sessionsByEvent.booking_click.size;
  const confirmed = sessionsByEvent.booking_confirmed.size;
  const visitors = sessionsByStep.traffic.size;
  return {
    steps,
    events: Object.fromEntries(EVENT_TYPES.map(e => [e, sessionsByEvent[e].size])),
    bookingClickToConfirmed: clicks ? Number((confirmed / clicks).toFixed(4)) : null,
    visitorToConfirmed: visitors ? Number((confirmed / visitors).toFixed(4)) : null,
    note:
      confirmed === 0 && clicks > 0
        ? 'Calendar opens are not bookings: no booking has been confirmed yet.'
        : null,
  };
}

module.exports = {
  FunnelError,
  FUNNEL_STEPS,
  EVENT_STEPS,
  EVENT_TYPES,
  CLIENT_EVENT_TYPES,
  CRM_TRANSITIONS,
  FUNNEL_STATUSES,
  DEFAULT_CONFIG,
  LIMITS,
  normalizeSlug,
  normalizeFunnelConfig,
  isPlaceholderCalendar,
  videoEmbed,
  publicFunnelView,
  buildClientEvent,
  eventKey,
  validateLead,
  scoreLead,
  crmTransition,
  planFollowUps,
  funnelReport,
};

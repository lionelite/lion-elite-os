'use strict';

/**
 * Daily send budget and schedule for the HTTP-triggered clinic outreach run.
 *
 * Ramp: a new sending domain earns reputation by volume growing slowly, so the
 * cap starts at 20/day and grows by 10 for every FULL week since the first send
 * day, never above DAILY_SEND_CAP (alias DAILY_SEND_MAX; default 150):
 *
 *   cap = min(DAILY_SEND_CAP, 20 + 10 × floor(days since OUTREACH_START_DATE / 7))
 *
 * Before OUTREACH_START_DATE the cap is 0: the owner named the first send day,
 * and sending earlier would be sending before they said to. Without a valid
 * OUTREACH_START_DATE the ramp stays at its first step (20), so a missing or
 * mistyped date can never jump straight to the maximum.
 *
 * This cap is IN ADDITION to the transactional DAILY_EMAIL_LIMIT quota the
 * store enforces on every send (lib/postgres-prospect-store.js markQueue).
 * The effective number is the lower of the two.
 */

const DAY_MS = 86_400_000;
const RAMP_START = 20;
const RAMP_STEP = 10;
const DEFAULT_MAX = 150;

function parseStartDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // A bare YYYY-MM-DD is a calendar day in New York, not UTC midnight
  // (which is the evening before in ET).
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00-05:00`) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function effectiveDailyCap({ now = new Date(), env = process.env } = {}) {
  // DAILY_SEND_CAP is the owner-facing name; DAILY_SEND_MAX is the original
  // one and still honoured when DAILY_SEND_CAP is unset. Default 150.
  const set = v => (v === undefined || v === null || String(v).trim() === '' ? undefined : v);
  const maxRaw = Number(set(env.DAILY_SEND_CAP) ?? set(env.DAILY_SEND_MAX) ?? DEFAULT_MAX);
  const max = Number.isFinite(maxRaw) && maxRaw >= 0 ? Math.floor(maxRaw) : DEFAULT_MAX;
  const start = parseStartDate(env.OUTREACH_START_DATE);
  if (!start) {
    return { cap: Math.min(max, RAMP_START), weeks: 0, max, startDate: null, reason: 'OUTREACH_START_DATE not set or invalid: ramp held at its first step' };
  }
  const elapsed = new Date(now).getTime() - start.getTime();
  if (elapsed < 0) {
    return { cap: 0, weeks: 0, max, startDate: start.toISOString(), reason: 'before OUTREACH_START_DATE' };
  }
  const weeks = Math.floor(elapsed / (7 * DAY_MS));
  return { cap: Math.min(max, RAMP_START + RAMP_STEP * weeks), weeks, max, startDate: start.toISOString(), reason: 'ramp' };
}

/** Wall-clock parts in America/New_York, DST-correct. */
function newYorkClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return {
    weekday: parts.weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function isNewYorkWeekday(now = new Date()) {
  return !['Sat', 'Sun'].includes(newYorkClock(now).weekday);
}

/** 30–90 seconds between sends: no bursts. `random` is injectable for tests. */
function sendGapMs(random = Math.random) {
  return 30_000 + Math.floor(random() * 60_000);
}

/**
 * The approved sending window, enforced on the server so no scheduler (GitHub
 * Actions, Supabase pg_cron, a manual call) can send outside it.
 * OUTREACH_SEND_WINDOW="HH:MM-HH:MM" in America/New_York; default 09:00-15:00,
 * the historically approved window. An unparsable value fails closed.
 */
const DEFAULT_WINDOW = '09:00-15:00';
function sendWindow(env = process.env) {
  const raw = String(env.OUTREACH_SEND_WINDOW || DEFAULT_WINDOW).trim();
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return { valid: false, raw };
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (!(start >= 0 && end <= 24 * 60 && start < end)) return { valid: false, raw };
  return { valid: true, raw, start, end };
}

/** Where `now` sits in the window: open?, and ms until it closes. */
function windowState(now = new Date(), env = process.env) {
  const w = sendWindow(env);
  const clock = newYorkClock(now);
  const minute = clock.hour * 60 + clock.minute;
  if (!w.valid) return { open: false, msLeft: 0, window: w.raw, reason: `OUTREACH_SEND_WINDOW "${w.raw}" is not HH:MM-HH:MM; sending held` };
  const open = minute >= w.start && minute < w.end;
  const secondsIntoMinute = new Date(now).getUTCSeconds();
  const msLeft = open ? ((w.end - minute) * 60 - secondsIntoMinute) * 1000 : 0;
  return { open, msLeft, window: `${w.raw} America/New_York`, reason: open ? 'open' : `outside the sending window ${w.raw} America/New_York` };
}

/**
 * Spread what is left of today's allowance over what is left of the window, so
 * 150 lands across the day instead of in a burst that ends at 10 AM. Never less
 * than the 30–90 s jittered gap. 0.9 leaves headroom for the time between runs.
 */
function pacedGapMs({ remainingAllowance, msLeft, random = Math.random }) {
  const jitter = sendGapMs(random);
  if (!(remainingAllowance > 0) || !(msLeft > 0)) return jitter;
  return Math.max(jitter, Math.min(10 * 60_000, Math.floor((msLeft * 0.9) / remainingAllowance)));
}

module.exports = { sendWindow, windowState, pacedGapMs, DEFAULT_WINDOW, effectiveDailyCap, parseStartDate, newYorkClock, isNewYorkWeekday, sendGapMs, RAMP_START, RAMP_STEP, DEFAULT_MAX };

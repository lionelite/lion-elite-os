'use strict';

/**
 * Daily send budget and schedule for the HTTP-triggered clinic outreach run.
 *
 * Ramp: a new sending domain earns reputation by volume growing slowly, so the
 * cap starts at 20/day and grows by 10 for every FULL week since the first send
 * day, never above DAILY_SEND_MAX (default 150):
 *
 *   cap = min(DAILY_SEND_MAX, 20 + 10 × floor(days since OUTREACH_START_DATE / 7))
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
  const maxRaw = Number(env.DAILY_SEND_MAX ?? DEFAULT_MAX);
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

module.exports = { effectiveDailyCap, parseStartDate, newYorkClock, isNewYorkWeekday, sendGapMs, RAMP_START, RAMP_STEP, DEFAULT_MAX };

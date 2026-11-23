'use strict';

// Duplicate-topic detection and seven-day content rotation (Issue #48).
//
// History entries are flat records: { date: 'YYYY-MM-DD', brand, slug }.
// `loadHistoryFromDir` builds them from previously committed
// content/generated/YYYY-MM-DD/social-content.json files.

const fs = require('fs');
const path = require('path');

const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayIndex(dateStr) {
  const parsed = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date: ${dateStr} (expected YYYY-MM-DD)`);
  }
  return Math.floor(parsed / DAY_MS);
}

function recentSlugs({ history = [], brand, date, windowDays = 7 }) {
  const end = dayIndex(date);
  const start = end - windowDays;
  const used = new Set();
  for (const entry of history) {
    if (entry.brand !== brand) continue;
    const idx = dayIndex(entry.date);
    if (idx >= start && idx < end) used.add(entry.slug);
  }
  return used;
}

function isDuplicateTopic({ slug, brand, history, date, windowDays = 7 }) {
  return recentSlugs({ history, brand, date, windowDays }).has(slug);
}

/**
 * Pick `count` distinct topics for a brand and date, skipping anything the
 * brand used in the previous `windowDays` days. The starting point rotates
 * with the calendar day, so even with no history the pool advances daily
 * instead of repeating topic #1. If the whole pool was used inside the
 * window (pool smaller than window x count), falls back to the
 * least-recently-used topics rather than failing.
 */
function selectTopics({ profile, history = [], date, count = 2, windowDays = 7 }) {
  const pool = profile.topics;
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error(`Brand ${profile.key} has no topic pool`);
  }

  const used = recentSlugs({ history, brand: profile.key, date, windowDays });
  const offset = dayIndex(date) % pool.length;
  const rotated = pool.slice(offset).concat(pool.slice(0, offset));

  const selected = [];
  for (const topic of rotated) {
    if (selected.length >= count) break;
    if (!used.has(topic.slug)) selected.push(topic);
  }

  if (selected.length < count) {
    const lastUsed = new Map();
    for (const entry of history) {
      if (entry.brand !== profile.key) continue;
      const idx = dayIndex(entry.date);
      const prev = lastUsed.get(entry.slug);
      if (prev === undefined || idx > prev) lastUsed.set(entry.slug, idx);
    }
    const chosen = new Set(selected.map((t) => t.slug));
    const fallback = rotated
      .filter((t) => !chosen.has(t.slug))
      .sort((a, b) => (lastUsed.get(a.slug) || 0) - (lastUsed.get(b.slug) || 0));
    for (const topic of fallback) {
      if (selected.length >= count) break;
      selected.push(topic);
    }
  }

  return selected;
}

/**
 * Read prior generation runs from `content/generated/` and flatten them
 * into history entries for the `windowDays` days before `date`.
 */
function loadHistoryFromDir(generatedDir, { date, windowDays = 7 } = {}) {
  const history = [];
  if (!fs.existsSync(generatedDir)) return history;

  const end = dayIndex(date);
  const start = end - windowDays;

  for (const name of fs.readdirSync(generatedDir)) {
    if (!DATE_DIR_PATTERN.test(name)) continue;
    let idx;
    try {
      idx = dayIndex(name);
    } catch {
      continue;
    }
    if (idx < start || idx >= end) continue;

    const file = path.join(generatedDir, name, 'social-content.json');
    if (!fs.existsSync(file)) continue;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // A corrupt historical file should not block today's run.
    }
    for (const [brand, data] of Object.entries(payload.brands || {})) {
      for (const piece of data.pieces || []) {
        if (piece.topic && piece.topic.slug) {
          history.push({ date: name, brand, slug: piece.topic.slug });
        }
      }
    }
  }

  return history;
}

module.exports = {
  dayIndex,
  isDuplicateTopic,
  selectTopics,
  loadHistoryFromDir
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectTopics, isDuplicateTopic, loadHistoryFromDir } = require('../lib/social/topic-rotation');
const { getBrandProfile, BRAND_KEYS } = require('../lib/social/brand-profiles');
const { generateDailyPlan } = require('../lib/social/content-generator');

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test('never repeats a topic within a seven-day window across a full month of generation', () => {
  for (const brand of BRAND_KEYS) {
    const history = [];
    const lastUsed = new Map();
    let date = '2026-07-01';
    for (let day = 0; day < 30; day += 1) {
      const plan = generateDailyPlan({ brand, date, history });
      const slugs = plan.pieces
        .filter((p) => p.slot === 'feed' || p.slot === 'reel')
        .map((p) => p.topic.slug);
      assert.equal(new Set(slugs).size, slugs.length, `${brand} ${date}: same-day duplicate`);
      for (const slug of slugs) {
        if (lastUsed.has(slug)) {
          const gap = (Date.parse(date) - Date.parse(lastUsed.get(slug))) / 86400000;
          assert.ok(gap > 7, `${brand}: ${slug} repeated after ${gap} days (${lastUsed.get(slug)} -> ${date})`);
        }
        lastUsed.set(slug, date);
        history.push({ date, brand, slug });
      }
      date = addDays(date, 1);
    }
  }
});

test('isDuplicateTopic flags topics used inside the window and ignores older ones', () => {
  const history = [
    { date: '2026-07-10', brand: 'wellness', slug: 'how-to-read-a-coa' },
    { date: '2026-07-01', brand: 'wellness', slug: 'purity-testing-methods' },
    { date: '2026-07-10', brand: 'beauty', slug: 'foundation-first' }
  ];
  assert.equal(isDuplicateTopic({ slug: 'how-to-read-a-coa', brand: 'wellness', history, date: '2026-07-15' }), true);
  // Outside the 7-day window.
  assert.equal(isDuplicateTopic({ slug: 'purity-testing-methods', brand: 'wellness', history, date: '2026-07-15' }), false);
  // History is per brand.
  assert.equal(isDuplicateTopic({ slug: 'foundation-first', brand: 'wellness', history, date: '2026-07-15' }), false);
});

test('falls back to least-recently-used topics when the pool is exhausted', () => {
  const profile = getBrandProfile('wellness');
  const history = profile.topics.map((topic, index) => ({
    // Every topic used within the window; the earliest ones should return first.
    date: addDays('2026-07-01', index % 6),
    brand: 'wellness',
    slug: topic.slug
  }));
  const selected = selectTopics({ profile, history, date: '2026-07-07', count: 2 });
  assert.equal(selected.length, 2);
  assert.notEqual(selected[0].slug, selected[1].slug);
});

test('loadHistoryFromDir reads committed runs inside the window and skips corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-history-'));
  try {
    const write = (day, payload) => {
      fs.mkdirSync(path.join(dir, day), { recursive: true });
      fs.writeFileSync(path.join(dir, day, 'social-content.json'), payload);
    };
    write('2026-07-15', JSON.stringify({
      brands: { wellness: { pieces: [{ slot: 'feed', topic: { slug: 'how-to-read-a-coa' } }] } }
    }));
    write('2026-07-01', JSON.stringify({
      brands: { wellness: { pieces: [{ slot: 'feed', topic: { slug: 'too-old' } }] } }
    }));
    write('2026-07-16', 'not json {');
    fs.mkdirSync(path.join(dir, 'not-a-date'), { recursive: true });

    const history = loadHistoryFromDir(dir, { date: '2026-07-17' });
    assert.deepEqual(history, [
      { date: '2026-07-15', brand: 'wellness', slug: 'how-to-read-a-coa' }
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadHistoryFromDir returns empty history when the directory does not exist', () => {
  assert.deepEqual(
    loadHistoryFromDir('/nonexistent/social-history', { date: '2026-07-17' }),
    []
  );
});

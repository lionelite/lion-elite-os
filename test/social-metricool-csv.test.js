'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HEADER, escapeCsvField, buildMetricoolCsv, pieceToRows } = require('../lib/social/metricool-csv');
const { generateDailyPlan } = require('../lib/social/content-generator');
const { BRAND_KEYS } = require('../lib/social/brand-profiles');

function todaysPieces() {
  return BRAND_KEYS.flatMap((brand) => generateDailyPlan({ brand, date: '2026-07-17' }).pieces);
}

test('escapes commas, quotes, and newlines per RFC 4180', () => {
  assert.equal(escapeCsvField('plain'), 'plain');
  assert.equal(escapeCsvField('a,b'), '"a,b"');
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvField(null), '');
});

test('produces the Metricool header and one row per platform variant', () => {
  const { csv, rowCount } = buildMetricoolCsv(todaysPieces());
  const headerLine = csv.slice(0, csv.indexOf('\n'));
  assert.equal(headerLine, HEADER.join(','));
  // Per brand: feed = 4 networks (FB, Twitter/X, LinkedIn, IG), reel = 2
  // (IG, TikTok). Stories are JSON/media-prompt only. 2 brands x 6 = 12.
  assert.equal(rowCount, 12);
});

test('each row schedules exactly one network', () => {
  const pieces = todaysPieces();
  for (const piece of pieces) {
    for (const row of pieceToRows(piece)) {
      const flags = ['Facebook', 'Twitter', 'LinkedIn', 'Instagram', 'Pinterest', 'TikTok']
        .map((column) => row[column]);
      assert.equal(flags.filter((f) => f === 'TRUE').length, 1);
      assert.equal(row.Draft, 'FALSE');
      assert.match(row.Date, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(row.Time, /^\d{2}:\d{2}$/);
    }
  }
});

test('stories never become CSV rows', () => {
  const stories = todaysPieces().filter((p) => p.slot.startsWith('story'));
  assert.ok(stories.length > 0);
  for (const story of stories) {
    assert.deepEqual(pieceToRows(story), []);
  }
});

test('every data row parses back to the exact header column count', () => {
  const { csv } = buildMetricoolCsv(todaysPieces());
  // Minimal CSV parser honoring quoted fields, to prove re-importability.
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"' && csv[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n') { record.push(field); records.push(record); field = ''; record = []; }
    else field += ch;
  }
  assert.ok(records.length > 1);
  for (const parsed of records) {
    assert.equal(parsed.length, HEADER.length);
  }
});

test('rows are sorted chronologically', () => {
  const { csv } = buildMetricoolCsv(todaysPieces());
  const stamps = [...csv.matchAll(/,(\d{4}-\d{2}-\d{2}),(\d{2}:\d{2}),/g)]
    .map((m) => `${m[1]} ${m[2]}`);
  const sorted = [...stamps].sort();
  assert.deepEqual(stamps, sorted);
});

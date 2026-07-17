'use strict';

// Metricool bulk-import CSV builder (Issue #48, Phase 1 free workflow).
//
// Column layout follows Metricool's published CSV template: Text, Date
// (YYYY-MM-DD), Time (HH:MM), Draft, one TRUE/FALSE column per network,
// then Picture Url slots. The header lives in one constant so it can be
// adjusted in a single place if Metricool revises its template — download
// the current template from Metricool's planner to cross-check before the
// first import.
//
// Only feed posts and reel captions become CSV rows. Stories are excluded
// on purpose: Metricool's CSV import schedules regular posts, so a story
// row would publish as a feed post. Stories ship as JSON + media prompts
// in content/generated/ instead.

const HEADER = Object.freeze([
  'Text',
  'Date',
  'Time',
  'Draft',
  'Facebook',
  'Twitter',
  'LinkedIn',
  'Instagram',
  'Pinterest',
  'TikTok',
  'Picture Url 1',
  'Picture Url 2'
]);

// Metricool network column -> our platform key.
const NETWORK_COLUMNS = Object.freeze({
  Facebook: 'facebook',
  Twitter: 'x',
  LinkedIn: 'linkedin',
  Instagram: 'instagram',
  Pinterest: 'pinterest',
  TikTok: 'tiktok'
});

const CSV_SLOTS = Object.freeze(new Set(['feed', 'reel']));

function escapeCsvField(value) {
  const text = String(value == null ? '' : value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Convert one generated piece into CSV rows — one row per platform variant,
 * because captions are platform-specific (a shared row with multiple TRUE
 * flags would post identical text everywhere).
 */
function pieceToRows(piece) {
  if (!CSV_SLOTS.has(piece.slot)) return [];
  const rows = [];
  for (const [column, platformKey] of Object.entries(NETWORK_COLUMNS)) {
    const variant = piece.platforms && piece.platforms[platformKey];
    if (!variant) continue;
    const row = {
      Text: variant.text,
      Date: piece.schedule.date,
      Time: piece.schedule.time,
      Draft: 'FALSE',
      Facebook: 'FALSE',
      Twitter: 'FALSE',
      LinkedIn: 'FALSE',
      Instagram: 'FALSE',
      Pinterest: 'FALSE',
      TikTok: 'FALSE',
      'Picture Url 1': '',
      'Picture Url 2': ''
    };
    row[column] = 'TRUE';
    rows.push(row);
  }
  return rows;
}

/**
 * Build a Metricool-compatible CSV from generated pieces. Pieces that
 * failed compliance must be filtered out by the caller before this point.
 */
function buildMetricoolCsv(pieces) {
  const rows = [];
  for (const piece of pieces) {
    rows.push(...pieceToRows(piece));
  }
  rows.sort((a, b) => (a.Date + a.Time).localeCompare(b.Date + b.Time));
  const lines = [HEADER.join(',')];
  for (const row of rows) {
    lines.push(HEADER.map((column) => escapeCsvField(row[column])).join(','));
  }
  return { csv: `${lines.join('\n')}\n`, rowCount: rows.length };
}

module.exports = {
  HEADER,
  NETWORK_COLUMNS,
  escapeCsvField,
  pieceToRows,
  buildMetricoolCsv
};

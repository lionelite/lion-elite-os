'use strict';

// Loader for the swipe database. Reads the JSON seed, validates every row
// against the schema, and exposes query helpers. Invalid rows are surfaced
// (not silently dropped) so a malformed entry gets fixed, not hidden.

const fs = require('fs');
const path = require('path');
const { validateEntry, isWinner } = require('./swipe-schema');

const DATA_FILE = path.join(__dirname, '..', 'data', 'swipe-database.json');

function loadRaw(file = DATA_FILE) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

/**
 * Load and validate. Returns { entries, winners, invalid, warnings }.
 * - entries  : all structurally-valid rows
 * - winners  : rows with at least one positive, sourced performance metric
 * - invalid  : [{ id, errors }] for rows that failed validation
 * - warnings : [{ id, warnings }] honesty gaps (usable but incomplete)
 */
function load(file = DATA_FILE) {
  const raw = loadRaw(file);
  const entries = [];
  const invalid = [];
  const warnings = [];
  for (const entry of raw) {
    const { valid, errors, warnings: w } = validateEntry(entry);
    if (!valid) {
      invalid.push({ id: entry && entry.id ? entry.id : '(no id)', errors });
      continue;
    }
    if (w.length) warnings.push({ id: entry.id, warnings: w });
    entries.push(entry);
  }
  return {
    entries,
    winners: entries.filter(isWinner),
    invalid,
    warnings
  };
}

module.exports = { DATA_FILE, load, loadRaw };

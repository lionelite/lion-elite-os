'use strict';

/**
 * Source-text regression guard for the funnel_events table.
 *
 * CI provisions Redis but not Postgres, so nothing here ever executes this SQL
 * against a real database. That is exactly how `audit_events` shipped — a store
 * querying a table that did not exist, unguarded, until it threw in production.
 * These assertions keep lib/revenue/funnel-store.js and db/schema.sql from
 * drifting apart in the same way.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const schemaSource = fs.readFileSync(path.join(root, 'db', 'schema.sql'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'lib', 'revenue', 'funnel-store.js'), 'utf8');

const tableBlock = (() => {
  const start = schemaSource.indexOf('CREATE TABLE IF NOT EXISTS funnel_events');
  assert.notEqual(start, -1, 'db/schema.sql must define funnel_events');
  const block = schemaSource.slice(start);
  return block.slice(0, block.indexOf(');'));
})();

test('db/schema.sql defines every column the store writes', () => {
  for (const column of [
    'event_key',
    'type',
    'brand',
    'source',
    'subject_id',
    'subject_hash',
    'amount_cents',
    'occurred_at',
    'metadata',
  ]) {
    assert.match(tableBlock, new RegExp(`\\b${column}\\b`), `funnel_events must define ${column}`);
  }
});

test('event_key is UNIQUE, without which ON CONFLICT cannot dedupe revenue', () => {
  assert.match(tableBlock, /event_key TEXT NOT NULL UNIQUE/);
  assert.match(storeSource, /ON CONFLICT \(event_key\) DO NOTHING/);
});

test('amount_cents cannot go negative at the database level', () => {
  assert.match(tableBlock, /amount_cents INTEGER CHECK \(amount_cents IS NULL OR amount_cents >= 0\)/);
});

test('the store queries only funnel_events columns that exist', () => {
  const columnsInStore = storeSource.match(/row\.([a-z_]+)/g) || [];
  const schemaColumns = new Set(
    [...tableBlock.matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1])
  );
  schemaColumns.add('event_id');
  for (const ref of columnsInStore) {
    const column = ref.slice(4);
    assert.ok(schemaColumns.has(column), `funnel-store reads row.${column}, which db/schema.sql does not define`);
  }
});

test('the reporting window index exists, so the daily report does not table-scan', () => {
  assert.match(schemaSource, /CREATE INDEX IF NOT EXISTS funnel_events_window_idx ON funnel_events\(occurred_at\)/);
  assert.match(schemaSource, /funnel_events_brand_source_idx ON funnel_events\(brand, source, occurred_at\)/);
});

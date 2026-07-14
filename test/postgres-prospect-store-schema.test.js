'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const storeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'postgres-prospect-store.js'), 'utf8');
const schemaSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

test('db/schema.sql defines prospect_events with a "type" column, not audit_events', () => {
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS prospect_events/);
  assert.doesNotMatch(schemaSource, /CREATE TABLE IF NOT EXISTS audit_events/);
  const tableBlock = schemaSource.slice(schemaSource.indexOf('CREATE TABLE IF NOT EXISTS prospect_events'));
  assert.match(tableBlock.slice(0, tableBlock.indexOf(');')), /\btype TEXT NOT NULL\b/);
});

test('lib/postgres-prospect-store.js only queries the real prospect_events table/columns, never the nonexistent audit_events table', () => {
  assert.doesNotMatch(storeSource, /audit_events/);
  assert.doesNotMatch(storeSource, /event_type/);
  assert.match(storeSource, /INSERT INTO prospect_events \(event_id, prospect_id, type, actor, data\)/);
  assert.match(storeSource, /FROM prospect_events WHERE prospect_id=\$1/);
  assert.match(storeSource, /SELECT COUNT\(\*\)::int AS count FROM prospect_events/);
});

test('STAGES includes affiliate_applied for the affiliate-application intake path', () => {
  const { STAGES } = require('../lib/postgres-prospect-store');
  assert.ok(STAGES.includes('affiliate_applied'));
  assert.ok(STAGES.includes('suppressed'));
});

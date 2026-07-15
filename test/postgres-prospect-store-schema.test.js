'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createDatabaseId } = require('../lib/postgres-prospect-store');

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

test('Postgres store generates IDs compatible with UUID database columns', () => {
  assert.match(createDatabaseId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.doesNotMatch(storeSource, /`(?:pro|evt|que)_\$\{crypto\.randomUUID\(\)\}`/);
});

test('daily email quota SQL matches the daily_usage schema', () => {
  const tableStart = schemaSource.indexOf('CREATE TABLE IF NOT EXISTS daily_usage');
  const tableBlock = schemaSource.slice(tableStart, schemaSource.indexOf(');', tableStart));

  assert.match(tableBlock, /channel TEXT NOT NULL/);
  assert.match(tableBlock, /sent_count INTEGER NOT NULL/);
  assert.doesNotMatch(tableBlock, /email_sent|updated_at/);

  assert.doesNotMatch(storeSource, /email_sent/);
  assert.match(storeSource, /WHERE usage_day=\$1 AND channel='email'/);
  assert.match(storeSource, /INSERT INTO daily_usage \(usage_day,channel,sent_count\)/);
  assert.match(storeSource, /ON CONFLICT \(usage_day,channel\)/);
  assert.match(storeSource, /RETURNING sent_count/);
});

test('STAGES includes affiliate_applied for the affiliate-application intake path', () => {
  const { STAGES } = require('../lib/postgres-prospect-store');
  assert.ok(STAGES.includes('affiliate_applied'));
  assert.ok(STAGES.includes('suppressed'));
});

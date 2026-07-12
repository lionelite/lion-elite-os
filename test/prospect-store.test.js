'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProspectStore } = require('../lib/prospect-store');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-elite-store-'));
  return new ProspectStore(path.join(dir, 'prospects.json'));
}

const business = { name: 'Elite Fitness Lab', domain: 'elitefitness.example', phone: '216-555-0100', region: 'OH' };

test('creates a durable prospect and blocks duplicates', () => {
  const db = store();
  const first = db.create({ business, campaignId: 'campaign_1' });
  const second = db.create({ business, campaignId: 'campaign_1' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.prospect.prospectId, second.prospect.prospectId);
  assert.equal(db.metrics().prospects, 1);
});

test('tracks lifecycle transitions and timeline events', () => {
  const db = store();
  const { prospect } = db.create({ business });
  db.transition(prospect.prospectId, 'verified', { confidence: 0.95 }, 'verification-agent');
  const updated = db.get(prospect.prospectId);
  assert.equal(updated.stage, 'verified');
  assert.equal(db.timeline(prospect.prospectId).at(-1).type, 'prospect.stage_changed');
});

test('fails closed when queue authorization is missing', () => {
  const db = store();
  const { prospect } = db.create({ business });
  assert.throws(() => db.enqueue(prospect.prospectId, null, { channel: 'email', recipient: 'info@elitefitness.example', body: 'Hello' }), /authorization/i);
});

test('deduplicates queue items by idempotency key', () => {
  const db = store();
  const { prospect } = db.create({ business, campaignId: 'campaign_1' });
  const authorization = { authorized: true, idempotencyKey: 'idem_123', validationRunId: 'val_1' };
  const message = { channel: 'email', recipient: 'info@elitefitness.example', subject: 'Partnership', body: 'Hello', messageVersion: 'v1' };
  const first = db.enqueue(prospect.prospectId, authorization, message);
  const second = db.enqueue(prospect.prospectId, authorization, message);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(db.listQueue().length, 1);
});

test('suppressed prospects cannot be queued', () => {
  const db = store();
  const { prospect } = db.create({ business });
  db.transition(prospect.prospectId, 'suppressed');
  assert.throws(() => db.enqueue(
    prospect.prospectId,
    { authorized: true, idempotencyKey: 'idem_456' },
    { channel: 'email', recipient: 'info@elitefitness.example', body: 'Hello' }
  ), /suppressed/i);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ALLOWED_QUEUE_ACTIONS, BLOCKED_ACTIONS, hasConsumer, deliveryGap, orphanedActions } = require('../lib/action-catalog');
const { consumedQueues } = require('../lib/queue-manifest');

test('the catalog is dependency-free — importable without bullmq or Redis', () => {
  // The whole reason this module was extracted. If this test can run, it worked.
  assert.ok(Object.keys(ALLOWED_QUEUE_ACTIONS).length > 0);
  assert.ok(BLOCKED_ACTIONS.size > 0);
});

test('the dispatcher re-exports the same objects, so existing consumers are unaffected', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'openai-action-dispatcher.js'), 'utf8');
  assert.match(source, /require\('\.\/action-catalog'\)/);
  assert.match(source, /module\.exports = \{ ALLOWED_QUEUE_ACTIONS, BLOCKED_ACTIONS/);
});

test('every allowlisted action names a queue and a job', () => {
  for (const [action, target] of Object.entries(ALLOWED_QUEUE_ACTIONS)) {
    assert.ok(target.queue, `${action} has no queue`);
    assert.ok(target.job, `${action} has no job`);
  }
});

test('every queue an action targets is a real key in the queue registry', () => {
  // job-queues.js requires bullmq, so read its QUEUE_NAMES from source instead.
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'job-queues.js'), 'utf8');
  const block = source.slice(source.indexOf('const QUEUE_NAMES'), source.indexOf('});', source.indexOf('const QUEUE_NAMES')));
  const keys = [...block.matchAll(/^\s+([a-zA-Z]+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 5, 'failed to parse QUEUE_NAMES');
  for (const [action, target] of Object.entries(ALLOWED_QUEUE_ACTIONS)) {
    assert.ok(keys.includes(target.queue), `${action} targets queue "${target.queue}", which is not a key in job-queues.js QUEUE_NAMES`);
  }
});

// Consumption now lives in lib/queue-manifest.js and is verified against the
// real worker files by test/queue-producer-consumer.test.js, in both directions.
test('the catalog reads consumption from the manifest rather than duplicating it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'action-catalog.js'), 'utf8');
  assert.match(source, /require\('\.\/queue-manifest'\)/);
  assert.ok(!/const CONSUMED_QUEUES = Object\.freeze\(new Set/.test(source), 'the duplicate queue list is back — it can drift from the workers');
  assert.ok(consumedQueues().length >= 4);
});

test('hasConsumer distinguishes processed actions from no-ops', () => {
  assert.equal(hasConsumer('morning-brief'), true, 'analytics is consumed by executive-worker');
  assert.equal(hasConsumer('draft-outreach'), true, 'email is consumed by outreach-worker');
  assert.equal(hasConsumer('qualify-prospect'), false, 'qualification has no worker');
  assert.equal(hasConsumer('not-an-action'), false);
});

test('discover-prospects reaches the worker — its job name was rejected before', () => {
  // The action verb stays discover-prospects; the job name must be the one
  // discovery-worker answers to, or it throws UNSUPPORTED_DISCOVERY_JOB.
  assert.equal(ALLOWED_QUEUE_ACTIONS['discover-prospects'].job, 'scheduled-business-discovery');
  assert.equal(hasConsumer('discover-prospects'), true);
  assert.equal(deliveryGap('discover-prospects'), null);
});

test('deliveryGap distinguishes no-consumer from a rejected job name', () => {
  assert.equal(deliveryGap('morning-brief'), null);
  assert.equal(deliveryGap('qualify-prospect').reason, 'no-consumer');
  assert.match(deliveryGap('not-an-action').reason, /unknown-action/);
});

// This documents a real pre-existing gap rather than asserting it is fine. If
// someone writes the missing workers, this test should be updated — and the
// message says so, so it does not read as a mystery.
test('the known orphaned actions are exactly these four, until workers are written', () => {
  assert.deepEqual(orphanedActions().sort(), [
    'enrich-prospect',
    'generate-social-content',
    'qualify-prospect',
    'research-prospect',
  ], 'the set of allowlisted actions with no consuming worker changed — if a worker was added, update CONSUMED_QUEUES; if an action was added, it may be a no-op');
});

test('no blocked action is also allowlisted', () => {
  for (const blocked of BLOCKED_ACTIONS) {
    assert.ok(!ALLOWED_QUEUE_ACTIONS[blocked], `${blocked} is both blocked and allowlisted`);
  }
});

test('every outward-facing or irreversible act is on the blocked list', () => {
  for (const act of ['send-email', 'publish-content', 'charge-payment', 'issue-refund', 'deploy-production', 'delete-record']) {
    assert.ok(BLOCKED_ACTIONS.has(act), `${act} must stay blocked`);
  }
});

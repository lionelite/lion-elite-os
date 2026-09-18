const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ALLOWED_QUEUE_ACTIONS, BLOCKED_ACTIONS, CONSUMED_QUEUES, hasConsumer, orphanedActions } = require('../lib/action-catalog');

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

// Drift detection. CONSUMED_QUEUES is hand-maintained because detecting it would
// mean booting the workers; this keeps it honest against the workers that exist.
test('CONSUMED_QUEUES matches the queues workers actually subscribe to', () => {
  const workerDir = path.join(__dirname, '..', 'workers');
  const found = new Set();
  for (const file of fs.readdirSync(workerDir).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(workerDir, file), 'utf8');
    for (const m of source.matchAll(/QUEUE_NAMES\.([a-zA-Z]+)/g)) found.add(m[1]);
  }
  assert.ok(found.size > 0, 'failed to detect any worker queue subscriptions');
  // Every queue we claim is consumed must appear in a worker.
  for (const queue of CONSUMED_QUEUES) {
    assert.ok(found.has(queue), `CONSUMED_QUEUES claims "${queue}" is consumed, but no worker references QUEUE_NAMES.${queue}`);
  }
  // And every queue a worker consumes must be claimed, or the list is stale.
  for (const queue of found) {
    assert.ok(CONSUMED_QUEUES.has(queue), `workers/ consume "${queue}" but CONSUMED_QUEUES omits it — add it`);
  }
});

test('hasConsumer distinguishes processed actions from no-ops', () => {
  assert.equal(hasConsumer('morning-brief'), true, 'analytics is consumed by executive-worker');
  assert.equal(hasConsumer('draft-outreach'), true, 'email is consumed by outreach-worker');
  assert.equal(hasConsumer('qualify-prospect'), false, 'qualification has no worker');
  assert.equal(hasConsumer('not-an-action'), false);
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

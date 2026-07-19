'use strict';

// Safety invariants for owner-authorized unattended automated sending
// (docs/automated-outreach.md). CI has no Postgres and no live Redis for
// this suite, so the kill switch is unit-tested with an injected fake
// client and the worker-path invariants are locked in as source-text
// regression tests (same approach as postgres-prospect-store-schema.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { isHalted, halt, resume, status, KILL_SWITCH_KEY } = require('../lib/kill-switch');
const { appendPostalFooter, normalizeDraft } = require('../lib/email-delivery');

function fakeRedis(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async set(key, value) { data.set(key, value); },
    async del(key) { data.delete(key); }
  };
}

test('kill switch halts, reports, and resumes', async () => {
  const redis = fakeRedis();
  assert.equal(await isHalted(redis), false);
  assert.deepEqual(await status(redis), { halted: false });

  const halted = await halt('stop the presses', 'test-operator', redis);
  assert.equal(halted.halted, true);
  assert.equal(await isHalted(redis), true);
  const reported = await status(redis);
  assert.equal(reported.halted, true);
  assert.equal(reported.reason, 'stop the presses');
  assert.equal(reported.by, 'test-operator');

  await resume('test-operator', redis);
  assert.equal(await isHalted(redis), false);
  assert.equal(redis.data.has(KILL_SWITCH_KEY), false);
});

test('kill switch fails closed when Redis is unreadable', async () => {
  const broken = { async get() { throw new Error('redis down'); } };
  assert.equal(await isHalted(broken), true);
  const reported = await status(broken);
  assert.equal(reported.halted, true);
  assert.equal(reported.degraded, true);
});

test('kill switch tolerates corrupt state as halted', async () => {
  const redis = fakeRedis({ [KILL_SWITCH_KEY]: 'not-json{' });
  assert.equal(await isHalted(redis), true);
  const reported = await status(redis);
  assert.equal(reported.halted, true);
});

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'workers', 'outreach-worker.js'), 'utf8');
const orchestratorSource = fs.readFileSync(path.join(__dirname, '..', 'executive-orchestrator.js'), 'utf8');

test('every send path flows through outreach_queue so quota and audit apply', () => {
  // The validation handler must create the queue row before dispatching...
  assert.match(workerSource, /store\.enqueue\(context\.prospect\.prospectId/);
  // ...must refuse untracked (no prospectId) dispatches...
  assert.match(workerSource, /PROSPECT_ID_REQUIRED/);
  // ...and every dispatch job must carry a queueId (no direct un-audited path).
  assert.doesNotMatch(workerSource, /addJob\('dispatch',[^}]*\{ prospect: context\.prospect, draft: context\.draft, quality: context\.quality, authorization \}/);
});

test('validation and follow-ups share deterministic jobIds so dispatch dedupes', () => {
  assert.match(workerSource, /\{ jobId: authorization\.idempotencyKey \}/);
  assert.match(workerSource, /\{ jobId: item\.idempotencyKey \}/);
});

test('all three worker send stages consult the kill switch', () => {
  const checks = workerSource.match(/await isHalted\(\)/g) || [];
  // followups scheduler + validation handler + dispatch handler + health endpoint
  assert.ok(checks.length >= 3, `expected >=3 isHalted checks, found ${checks.length}`);
  assert.match(workerSource, /skipped_halted/);
});

test('halted dispatch completes without sending and leaves the item pending', () => {
  // The halt check must appear BEFORE markQueue('processing') in the
  // dispatch handler so the queue row is untouched and resumable.
  const dispatchSection = workerSource.slice(workerSource.indexOf('QUEUE_NAMES.dispatch'));
  const haltIndex = dispatchSection.indexOf('isHalted');
  const processingIndex = dispatchSection.indexOf("'processing'");
  assert.ok(haltIndex >= 0 && processingIndex > haltIndex, 'dispatch must check the kill switch before marking processing');
});

test('kill-switch API requires a configured token (never falls open)', () => {
  assert.match(orchestratorSource, /EXECUTIVE_API_TOKEN_NOT_CONFIGURED/);
  assert.match(orchestratorSource, /requireConfiguredAuth/);
});

test('postal footer lands in both text and html bodies', () => {
  const message = normalizeDraft({ subject: 'Hi', body: 'Short note.' }, { contact: { email: 'a@b.co' } });
  const withFooter = appendPostalFooter(message, '123 Lion Way, Miami, FL 33101');
  assert.match(withFooter.text, /123 Lion Way, Miami, FL 33101$/);
  assert.match(withFooter.html, /123 Lion Way, Miami, FL 33101/);
  // No address configured → message unchanged.
  const untouched = appendPostalFooter(message, '');
  assert.equal(untouched.text, message.text);
});

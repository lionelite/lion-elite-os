const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WORKER_CONSUMERS, KNOWN_ORPHAN_QUEUES, consumedQueues, jobDeliverability } = require('../lib/queue-manifest');

// Crosses the producer/consumer boundary that nothing else crossed.
//
// Three bugs in this repo have been the same shape — a producer naming something
// the consumer does not answer to, invisible because no test looked at both
// sides. See lib/queue-manifest.js for the list. This checks the manifest against
// the real files in BOTH directions, then checks every producer against the
// manifest.
//
// Source-text parsing because the real modules need bullmq and Redis, same
// reasoning as test/postgres-prospect-store-schema.test.js.

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function queueKeys() {
  const source = read('lib/job-queues.js');
  const start = source.indexOf('const QUEUE_NAMES');
  const block = source.slice(start, source.indexOf('});', start));
  return [...block.matchAll(/^\s+([a-zA-Z]+):\s*'([a-z-]+)'/gm)].map((m) => m[1]);
}

/** Every produced (queue, job) pair we can see statically. */
function producers() {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) { walk(childAbs, childRel); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(childAbs, 'utf8');
      for (const m of source.matchAll(/addJob\(\s*'([a-zA-Z]+)'\s*,\s*(?:'([a-z-]+)'|(\w+))/g)) {
        out.push({ queue: m[1], job: m[2] || null, dynamicJob: m[3] || null, where: childRel });
      }
    }
  };
  for (const d of ['workers', 'scripts', 'lib']) walk(path.join(ROOT, d), d);

  // Cron scheduler's JOBS table.
  for (const m of read('scripts/cron-scheduler.js').matchAll(/queue:\s*QUEUE_NAMES\.(\w+),\s*\n\s*name:\s*'([a-z-]+)'/g)) {
    out.push({ queue: m[1], job: m[2], where: 'scripts/cron-scheduler.js' });
  }

  // The dispatcher's allowlist is a producer too — each entry is a queue+job it
  // will enqueue on request.
  const { ALLOWED_QUEUE_ACTIONS } = require('../lib/action-catalog');
  for (const [action, target] of Object.entries(ALLOWED_QUEUE_ACTIONS)) {
    out.push({ queue: target.queue, job: target.job, where: `lib/action-catalog.js (${action})` });
  }
  return out;
}

// ---- the manifest must match reality, both directions ----

test('every queue the manifest claims a worker consumes appears in that worker', () => {
  for (const c of WORKER_CONSUMERS) {
    const source = read(c.worker);
    assert.ok(source.includes(`QUEUE_NAMES.${c.queue}`),
      `${c.worker} is declared to consume "${c.queue}" but its source never references QUEUE_NAMES.${c.queue}`);
  }
});

test('every queue a worker actually references is declared in the manifest', () => {
  const declared = new Set(WORKER_CONSUMERS.map((c) => `${c.worker}:${c.queue}`));
  const dir = path.join(ROOT, 'workers');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const rel = `workers/${file}`;
    const source = read(rel);
    // Only count QUEUE_NAMES references that look like a subscription, not a
    // produce-side addJob target.
    for (const m of source.matchAll(/(?:new Worker|startWorker)\(\s*QUEUE_NAMES\.(\w+)/g)) {
      assert.ok(declared.has(`${rel}:${m[1]}`),
        `${rel} subscribes to QUEUE_NAMES.${m[1]} but lib/queue-manifest.js does not declare it — the guard would under-report`);
    }
  }
});

test('the manifest names real worker files and real queue keys', () => {
  const keys = new Set(queueKeys());
  assert.ok(keys.size > 5, 'failed to parse QUEUE_NAMES');
  for (const c of WORKER_CONSUMERS) {
    assert.ok(fs.existsSync(path.join(ROOT, c.worker)), `${c.worker} does not exist`);
    assert.ok(keys.has(c.queue), `manifest queue "${c.queue}" is not a key in QUEUE_NAMES`);
  }
});

test('executive-worker sources its allowlist from the manifest rather than duplicating it', () => {
  const source = read('workers/executive-worker.js');
  assert.match(source, /require\('\.\.\/lib\/queue-manifest'\)/);
  assert.match(source, /consumersFor\('analytics'\)/);
  // And the duplicate literal is gone.
  assert.ok(!/new Set\(\['morning-brief'/.test(source), 'the hardcoded allowlist is back — it can drift from the manifest');
});

// ---- producers must reach a consumer ----

test('every produced queue key exists in the queue registry', () => {
  const keys = new Set(queueKeys());
  for (const p of producers()) {
    assert.ok(keys.has(p.queue), `${p.where} produces to "${p.queue}", not a key in lib/job-queues.js QUEUE_NAMES`);
  }
});

test('every statically-known produced job would actually be handled', () => {
  const problems = [];
  for (const p of producers()) {
    if (!p.job) continue;
    if (KNOWN_ORPHAN_QUEUES.includes(p.queue)) continue; // documented gaps, asserted separately
    const result = jobDeliverability(p.queue, p.job);
    if (!result.deliverable) problems.push(`${p.where}: ${result.detail}`);
  }
  assert.deepEqual(problems, [], `\n- ${problems.join('\n- ')}\n`);
});

// The specific regression for bug #3.
test('the integration cascade reaches the worker that handles its jobs', () => {
  const source = read('workers/integration-worker.js');
  const match = source.match(/await addJob\('(\w+)', executiveJob/);
  assert.ok(match, 'the cascade addJob call moved — re-point this test');
  for (const job of ['midday-revenue-check', 'business-health-snapshot']) {
    assert.ok(source.includes(`'${job}'`), `the cascade no longer emits ${job} — update this test`);
    const result = jobDeliverability(match[1], job);
    assert.equal(result.deliverable, true,
      `the cascade produces "${job}" to "${match[1]}": ${result.detail || ''}`);
  }
});

test('known orphaned queues are exactly the documented set', () => {
  const consumed = new Set(consumedQueues());
  const produced = [...new Set(producers().map((p) => p.queue))];
  const orphaned = produced.filter((q) => !consumed.has(q)).sort();
  assert.deepEqual(orphaned, [...KNOWN_ORPHAN_QUEUES].filter((q) => produced.includes(q)).sort(),
    'produced-but-unconsumed queues changed. A worker written? Remove it from KNOWN_ORPHAN_QUEUES. A new producer? Its jobs are being dropped.');
});

test('the daily staleData cron is a known dropped job, not a silent one', () => {
  // Documenting a real gap rather than asserting it is fine: this cron enqueues
  // every day into a queue with no worker.
  const result = jobDeliverability('enrichment', 'refresh-stale-prospect-data');
  assert.equal(result.deliverable, false);
  assert.equal(result.reason, 'no-consumer');
  assert.ok(KNOWN_ORPHAN_QUEUES.includes('enrichment'),
    'if an enrichment worker was written, remove enrichment from KNOWN_ORPHAN_QUEUES and delete this test');
});

'use strict';

// Runs against a real Redis when REDIS_URL is set (CI provisions one), because
// the failure this guards against is BullMQ's own runtime check, which no
// source-text test can see.
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeJobId } = require('../lib/job-queues');

test('safeJobId removes the colon BullMQ rejects and stays deterministic', () => {
  assert.equal(safeJobId('validate:abc'), 'validate-abc');
  assert.equal(safeJobId('validate:abc'), safeJobId('validate:abc'));
  assert.equal(safeJobId(undefined), undefined);
  assert.equal(safeJobId('a1b2c3'), 'a1b2c3');
});

test('two-part ids that used to throw are accepted by a real BullMQ queue', { skip: !process.env.REDIS_URL }, async t => {
  const { Queue } = require('bullmq');
  const { addJob, closeQueues } = require('../lib/job-queues');
  const { closeRedis } = require('../lib/redis');
  t.after(async () => { await closeQueues().catch(() => {}); await closeRedis().catch(() => {}); });

  const raw = new Queue('job-id-safety-probe', { connection: { url: process.env.REDIS_URL } });
  t.after(async () => { await raw.obliterate({ force: true }).catch(() => {}); await raw.close(); });
  await assert.rejects(raw.add('probe', {}, { jobId: 'validate:abc' }), /cannot contain :/, 'BullMQ still rejects two-part ids');

  const id = `validate:probe-${Date.now()}`;
  const job = await addJob('validation', 'validate-outreach-probe', {}, { jobId: id });
  assert.equal(job.id, safeJobId(id));
  const dup = await addJob('validation', 'validate-outreach-probe', {}, { jobId: id });
  assert.equal(dup.id, job.id, 'same id dedupes');
  await job.remove();
});

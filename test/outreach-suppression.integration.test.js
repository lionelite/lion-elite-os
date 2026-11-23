'use strict';

// PostgresProspectStore.contactFacts() and suppress() against the real schema.
// Runs in CI (Postgres is provisioned); skips locally without DATABASE_URL.
const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('suppression list and contact facts against the real schema', { skip: !databaseConfigured }, async t => {
  const { migrate, query, close } = require('../lib/database');
  const { holdExclusiveDb } = require('./helpers/db-exclusive');
  const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
  const release = await holdExclusiveDb();
  let tag = '';
  t.after(async () => {
    if (tag) await query('DELETE FROM outreach_suppressions WHERE lower(address) LIKE $1', [`%@${tag}.example`]);
    await release();
    await close();
  });
  await migrate();
  const store = new PostgresProspectStore();
  tag = Math.random().toString(36).slice(2, 8);
  const mk = (name, email) => store.create({ business: { name: `${name} ${tag}`, website: `https://${tag}.example`, region: 'miami-fl' }, contact: { email }, campaignId: 'osm-business-discovery' }, 'test');
  const a = (await mk('Alpha', `info@${tag}.example`)).prospect;
  const b = (await mk('Beta', `beta@${tag}.example`)).prospect;

  let facts = await store.contactFacts(a);
  assert.deepEqual(facts, { suppression: null, priorQueueCount: 0, domainContactedElsewhere: 0 });

  await store.enqueue(b.prospectId, { authorized: true, idempotencyKey: `k-${tag}` }, { recipient: `beta@${tag}.example`, body: 'x' });
  facts = await store.contactFacts(a);
  assert.equal(facts.domainContactedElsewhere, 1, 'same organisation contacted via another record');
  assert.equal((await store.contactFacts(b)).priorQueueCount, 1);

  assert.equal((await store.suppress({ address: `INFO@${tag}.example`, reason: 'opt_out' })).added, true);
  assert.equal((await store.suppress({ address: `info@${tag}.example`, reason: 'opt_out' })).added, false, 'idempotent');
  facts = await store.contactFacts(a);
  assert.equal(facts.suppression.reason, 'opt_out');
  assert.equal((await store.get(a.prospectId)).status, 'suppressed');
});

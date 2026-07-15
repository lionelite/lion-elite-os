'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('Postgres prospect lifecycle executes against the real schema', { skip: !databaseConfigured }, async t => {
  const { migrate, query, close } = require('../lib/database');
  const { PostgresProspectStore } = require('../lib/postgres-prospect-store');

  t.after(async () => close());
  await migrate();
  await query('TRUNCATE outreach_queue, prospect_events, prospects, daily_usage RESTART IDENTITY CASCADE');

  process.env.DAILY_EMAIL_LIMIT = '2';
  const store = new PostgresProspectStore();
  const created = await store.create({
    business: {
      name: 'Synthetic Affiliate Studio',
      website: 'https://synthetic-affiliate.example',
      country: 'US'
    },
    contact: { email: 'partners@synthetic-affiliate.example' },
    campaignId: 'affiliate_applications_ci'
  }, 'integration-test');

  assert.equal(created.duplicate, false);
  assert.match(created.prospect.prospectId, /^[0-9a-f-]{36}$/i);

  const affiliate = await store.transition(
    created.prospect.prospectId,
    'affiliate_applied',
    { source: 'ci' },
    'integration-test'
  );
  assert.equal(affiliate.stage, 'affiliate_applied');

  const queued = await store.enqueue(
    created.prospect.prospectId,
    { authorized: true, idempotencyKey: 'ci-affiliate-message-1', validationRunId: 'ci-validation-1' },
    {
      channel: 'email',
      recipient: 'partners@synthetic-affiliate.example',
      subject: 'Synthetic test',
      body: 'Synthetic CI message that is never delivered.'
    },
    new Date().toISOString(),
    'integration-test'
  );

  assert.equal(queued.duplicate, false);
  assert.match(queued.item.queueId, /^[0-9a-f-]{36}$/i);

  await store.markQueue(queued.item.queueId, 'processing', {}, 'integration-test');
  await store.markQueue(queued.item.queueId, 'sent', { providerMessageId: 'synthetic-ci-id' }, 'integration-test');

  const quota = await store.getDailyEmailQuota();
  assert.equal(quota.sent, 1);
  assert.equal(quota.remaining, 1);

  const timeline = await store.timeline(created.prospect.prospectId);
  assert.ok(timeline.some(event => event.type === 'prospect.created'));
  assert.ok(timeline.some(event => event.type === 'prospect.stage_changed'));
  assert.ok(timeline.some(event => event.type === 'outreach.sent'));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('Postgres prospect lifecycle executes against the real schema', { skip: !databaseConfigured }, async t => {
  const { migrate, query, close } = require('../lib/database');
  const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
  const { PostgresSubscriptionStore } = require('../lib/postgres-subscription-store');

  t.after(async () => close());
  await migrate();
  await query('TRUNCATE subscription_events, coaching_subscriptions, outreach_queue, prospect_events, prospects, daily_usage RESTART IDENTITY CASCADE');

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

  const subscriptions = new PostgresSubscriptionStore();
  const createdSubscription = await subscriptions.record('evt_subscription_created', 'customer.subscription.created', {
    subscriptionId: 'sub_synthetic_ci', customerId: 'cus_synthetic_ci',
    customerEmail: 'synthetic-client@example.test', status: 'active', amountCents: 29999,
    currency: 'usd', currentPeriodEnd: '2026-08-21T00:00:00.000Z', cancelAtPeriodEnd: false,
    program: 'lion_elite_beauty_basic', eventCreatedAt: '2026-07-21T16:35:17.000Z'
  }, '2026-07-21T16:35:17.000Z');
  assert.equal(createdSubscription.duplicate, false);
  assert.equal(createdSubscription.tracked, true);

  const duplicateSubscription = await subscriptions.record('evt_subscription_created', 'customer.subscription.created', {
    subscriptionId: 'sub_synthetic_ci', status: 'active'
  }, '2026-07-21T16:35:17.000Z');
  assert.equal(duplicateSubscription.duplicate, true);

  await subscriptions.record('evt_invoice_failed', 'invoice.payment_failed', {
    subscriptionId: 'sub_synthetic_ci', status: 'past_due', amountCents: 29999, currency: 'usd',
    eventCreatedAt: '2026-08-21T16:35:17.000Z'
  }, '2026-08-21T16:35:17.000Z');
  const failedSubscription = await query('SELECT * FROM coaching_subscriptions WHERE subscription_id=$1', ['sub_synthetic_ci']);
  assert.equal(failedSubscription.rows[0].status, 'past_due');
  assert.equal(failedSubscription.rows[0].next_action, 'recover_payment');

  await subscriptions.record('evt_stale_paid', 'invoice.paid', {
    subscriptionId: 'sub_synthetic_ci', status: 'active', amountCents: 29999, currency: 'usd',
    eventCreatedAt: '2026-08-01T16:35:17.000Z'
  }, '2026-08-22T16:35:17.000Z');
  const afterStale = await query('SELECT * FROM coaching_subscriptions WHERE subscription_id=$1', ['sub_synthetic_ci']);
  assert.equal(afterStale.rows[0].status, 'past_due');
  assert.equal(afterStale.rows[0].next_action, 'recover_payment');

  await subscriptions.record('evt_recovered_paid', 'invoice.paid', {
    subscriptionId: 'sub_synthetic_ci', status: 'active', amountCents: 29999, currency: 'usd',
    eventCreatedAt: '2026-08-22T16:35:17.000Z'
  }, '2026-08-22T16:35:17.000Z');
  const recovered = await query('SELECT * FROM coaching_subscriptions WHERE subscription_id=$1', ['sub_synthetic_ci']);
  assert.equal(recovered.rows[0].status, 'active');
  assert.equal(recovered.rows[0].next_action, 'confirm_recovery');
  const subscriptionEvents = await query('SELECT COUNT(*)::int AS count FROM subscription_events WHERE subscription_id=$1', ['sub_synthetic_ci']);
  assert.equal(subscriptionEvents.rows[0].count, 4);
});

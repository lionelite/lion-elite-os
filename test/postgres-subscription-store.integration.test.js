'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('Postgres coaching subscription lifecycle is idempotent', { skip: !databaseConfigured }, async t => {
  const { migrate, query, close } = require('../lib/database');
  const { PostgresSubscriptionStore } = require('../lib/postgres-subscription-store');
  t.after(async () => close());
  await migrate();
  await query('TRUNCATE subscription_events, coaching_subscriptions RESTART IDENTITY CASCADE');

  const store = new PostgresSubscriptionStore();
  const created = await store.record('evt_subscription_created', 'customer.subscription.created', {
    subscriptionId: 'sub_synthetic_ci', customerId: 'cus_synthetic_ci',
    customerEmail: 'synthetic-client@example.test', status: 'active', amountCents: 29999,
    currency: 'usd', currentPeriodEnd: '2026-08-21T00:00:00.000Z', cancelAtPeriodEnd: false,
    program: 'lion_elite_beauty_basic', eventCreatedAt: '2026-07-21T16:35:17.000Z'
  }, '2026-07-21T16:35:17.000Z');
  assert.equal(created.duplicate, false);
  assert.equal(created.tracked, true);

  const duplicate = await store.record('evt_subscription_created', 'customer.subscription.created', {
    subscriptionId: 'sub_synthetic_ci', status: 'active'
  }, '2026-07-21T16:35:17.000Z');
  assert.equal(duplicate.duplicate, true);

  await store.record('evt_invoice_failed', 'invoice.payment_failed', {
    subscriptionId: 'sub_synthetic_ci', status: 'past_due', amountCents: 29999, currency: 'usd',
    eventCreatedAt: '2026-08-21T16:35:17.000Z'
  }, '2026-08-21T16:35:17.000Z');

  const subscription = await query('SELECT * FROM coaching_subscriptions WHERE subscription_id=$1', ['sub_synthetic_ci']);
  assert.equal(subscription.rows[0].status, 'past_due');
  assert.equal(subscription.rows[0].next_action, 'recover_payment');

  await store.record('evt_stale_paid', 'invoice.paid', {
    subscriptionId: 'sub_synthetic_ci', status: 'active', amountCents: 29999, currency: 'usd',
    eventCreatedAt: '2026-08-01T16:35:17.000Z'
  }, '2026-08-22T16:35:17.000Z');
  const afterStale = await query('SELECT * FROM coaching_subscriptions WHERE subscription_id=$1', ['sub_synthetic_ci']);
  assert.equal(afterStale.rows[0].status, 'past_due');
  assert.equal(afterStale.rows[0].next_action, 'recover_payment');

  await store.record('evt_recovered_paid', 'invoice.paid', {
    subscriptionId: 'sub_synthetic_ci', status: 'active', amountCents: 29999, currency: 'usd',
    eventCreatedAt: '2026-08-22T16:35:17.000Z'
  }, '2026-08-22T16:35:17.000Z');
  const recovered = await query('SELECT * FROM coaching_subscriptions WHERE subscription_id=$1', ['sub_synthetic_ci']);
  assert.equal(recovered.rows[0].status, 'active');
  assert.equal(recovered.rows[0].next_action, 'confirm_recovery');
  const events = await query('SELECT COUNT(*)::int AS count FROM subscription_events WHERE subscription_id=$1', ['sub_synthetic_ci']);
  assert.equal(events.rows[0].count, 4);
});

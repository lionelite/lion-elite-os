'use strict';

const { withTransaction } = require('./db');

function asId(value) {
  if (typeof value === 'string') return value;
  return value?.id || null;
}

function asDateTime(unixSeconds) {
  const value = Number(unixSeconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

function normalizeStripeEvent(eventType, payload) {
  const object = payload?.data?.object || payload?.object || payload || {};
  const type = String(eventType || payload?.type || 'unknown').toLowerCase();
  const invoiceLine = object?.lines?.data?.[0] || {};
  const isSubscriptionObject = type.startsWith('customer.subscription.');
  const subscriptionId = isSubscriptionObject
    ? object.id
    : asId(object.subscription || object?.parent?.subscription_details?.subscription || object?.subscription_details?.subscription);
  const amount = object.amount_paid ?? object.amount_total ?? object.amount_due ?? object?.items?.data?.[0]?.price?.unit_amount ?? null;
  let status = object.status || null;
  if (type === 'invoice.paid' || type === 'checkout.session.completed') status = 'active';
  if (type === 'invoice.payment_failed' || type === 'invoice.payment_action_required') status = 'past_due';
  if (type === 'customer.subscription.deleted') status = 'canceled';

  return {
    subscriptionId: subscriptionId || null,
    customerId: asId(object.customer),
    customerEmail: object?.customer_details?.email || object?.customer_email || null,
    status,
    amountCents: amount !== null && amount !== undefined && Number.isInteger(Number(amount)) && Number(amount) >= 0 ? Number(amount) : null,
    currency: object.currency ? String(object.currency).toLowerCase() : null,
    currentPeriodEnd: asDateTime(object.current_period_end || invoiceLine?.period?.end),
    cancelAtPeriodEnd: object.cancel_at_period_end === undefined ? null : Boolean(object.cancel_at_period_end),
    program: object?.metadata?.program || object?.metadata?.brand || null,
    eventCreatedAt: asDateTime(payload?.created)
  };
}

function nextAction(eventType, status, existing) {
  if (eventType === 'invoice.payment_failed' || eventType === 'invoice.payment_action_required' || status === 'past_due') return 'recover_payment';
  if (eventType === 'customer.subscription.deleted' || status === 'canceled') return 'retention_review';
  if (status === 'active' && existing?.next_action === 'recover_payment') return 'confirm_recovery';
  if (!existing && (eventType === 'checkout.session.completed' || eventType === 'customer.subscription.created')) return 'complete_onboarding';
  return existing?.next_action || null;
}

class PostgresSubscriptionStore {
  async record(eventId, eventType, summary, receivedAt = new Date().toISOString()) {
    if (!eventId) throw Object.assign(new Error('Stripe event ID is required.'), { code: 'STRIPE_EVENT_ID_REQUIRED' });
    const subscriptionId = summary?.subscriptionId || null;
    const category = eventType === 'invoice.paid' || eventType === 'checkout.session.completed'
      ? 'subscription_revenue'
      : eventType === 'invoice.payment_failed' || eventType === 'invoice.payment_action_required'
        ? 'retention_risk'
        : 'subscription_lifecycle';

    const occurredAt = summary?.eventCreatedAt || receivedAt;
    return withTransaction(async client => {
      const claimed = await client.query(
        `INSERT INTO subscription_events (event_id,subscription_id,event_type,category,occurred_at)
         VALUES ($1,NULL,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [eventId, eventType, category, occurredAt]
      );
      if (!claimed.rowCount) return { duplicate: true, tracked: Boolean(subscriptionId), subscriptionId, eventType };

      let existing = null;
      if (subscriptionId) {
        const result = await client.query('SELECT * FROM coaching_subscriptions WHERE subscription_id=$1 FOR UPDATE', [subscriptionId]);
        existing = result.rows[0] || null;
        const status = summary.status || existing?.status || 'unknown';
        await client.query(
          `INSERT INTO coaching_subscriptions (
             subscription_id,customer_id,customer_email,status,amount_cents,currency,current_period_end,
             cancel_at_period_end,onboarding_status,next_action,last_event_id,last_event_created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11)
           ON CONFLICT (subscription_id) DO UPDATE SET
             customer_id=COALESCE(EXCLUDED.customer_id,coaching_subscriptions.customer_id),
             customer_email=COALESCE(EXCLUDED.customer_email,coaching_subscriptions.customer_email),
             status=EXCLUDED.status,
             amount_cents=COALESCE(EXCLUDED.amount_cents,coaching_subscriptions.amount_cents),
             currency=COALESCE(EXCLUDED.currency,coaching_subscriptions.currency),
             current_period_end=COALESCE(EXCLUDED.current_period_end,coaching_subscriptions.current_period_end),
             cancel_at_period_end=COALESCE($12,coaching_subscriptions.cancel_at_period_end),
             next_action=EXCLUDED.next_action,last_event_id=EXCLUDED.last_event_id,
             last_event_created_at=EXCLUDED.last_event_created_at,updated_at=NOW()
           WHERE EXCLUDED.last_event_created_at >= coaching_subscriptions.last_event_created_at`,
          [subscriptionId, summary.customerId, summary.customerEmail, status, summary.amountCents, summary.currency,
            summary.currentPeriodEnd, summary.cancelAtPeriodEnd ?? false, nextAction(eventType, status, existing), eventId, occurredAt,
            summary.cancelAtPeriodEnd ?? null]
        );
      }

      await client.query(
        `UPDATE subscription_events SET subscription_id=$2,amount_cents=$3,currency=$4,status=$5,data=$6::jsonb
         WHERE event_id=$1`,
        [eventId, subscriptionId, summary?.amountCents ?? null, summary?.currency || null,
          summary?.status || null, JSON.stringify({ program: summary?.program || null })]
      );

      return { duplicate: false, tracked: Boolean(subscriptionId), subscriptionId, eventType, status: summary?.status || null };
    });
  }
}

module.exports = { PostgresSubscriptionStore, normalizeStripeEvent };

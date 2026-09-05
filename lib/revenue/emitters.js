'use strict';

/**
 * Emitters that put real events into the funnel store.
 *
 * The instrumentation merged in #93 measures nothing on its own — until
 * something calls record(), the daily report is a well-tested way to print
 * zeros. This is the wiring: it reads the provider payloads the integration
 * gateway already receives and turns money into funnel events.
 *
 * Three properties matter more than coverage here:
 *
 *   1. Amounts are derived from the RAW payload, never from a formatted string.
 *      Shopify sends `total_price` in units ("149.99"); Stripe sends
 *      `amount_total` in cents (14999). Parsing a rendered "$149.99" back into
 *      a number is how a currency bug gets in.
 *   2. The idempotency key is the PROVIDER's own order id. Webhooks retry, and
 *      BullMQ retries on top of that; the same order must never be counted
 *      twice.
 *   3. Emitting is non-fatal. Analytics failing must never fail an order. Every
 *      entry point here returns a status object and swallows its own errors.
 */

const { buildEvent } = require('./funnel-events');

/**
 * Convert a major-unit amount ("149.99") to cents.
 *
 * Parsed as a decimal STRING rather than multiplied as a float. `1.005 * 100`
 * is 100.49999999999999 in IEEE 754, so the obvious Math.round(n * 100) quietly
 * rounds a cent away. Shopify sends these as strings, so exact parsing is both
 * available and correct.
 *
 * A numeric input has already lost that precision before it reaches us, so it
 * is converted through its string form as a best effort.
 */
function unitsToCents(value) {
  if (value === null || value === undefined || value === '') return null;

  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) {
    // Not a plain decimal (scientific notation, a negative, junk): reject
    // rather than guess at what it was meant to mean.
    return null;
  }

  const whole = Number(match[1]);
  const fractionText = match[2] || '';
  const hundredths = Number((fractionText[0] || '0') + (fractionText[1] || '0'));
  const nextDigit = Number(fractionText[2] || '0');

  const cents = whole * 100 + hundredths + (nextDigit >= 5 ? 1 : 0);
  return Number.isFinite(cents) ? cents : null;
}

function centsFromCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

const BRAND_BY_KEY = Object.freeze({
  wellness: 'wellness',
  beauty: 'beauty',
  alexthelionlifts: 'alexthelionlifts',
});

/**
 * Map a store webhook to the fields a funnel event needs.
 *
 * Returns null when the payload carries no usable amount or identity, so a
 * malformed webhook is skipped rather than recorded as a $0 sale — a zero-value
 * purchase would drag the average order value down and look like real data.
 */
function describeOrder(source, payload = {}, { brandKey = 'wellness' } = {}) {
  const brand = BRAND_BY_KEY[String(brandKey).toLowerCase()] || 'wellness';

  if (source === 'shopify') {
    const customer = payload.customer || {};
    const email = payload.email || customer.email || '';
    const providerId = payload.id ?? payload.order_number ?? payload.name;
    const amountCents = unitsToCents(payload.total_price);
    const subjectId = customer.id ? `shopify:customer:${customer.id}` : email ? `shopify:email:${email.toLowerCase()}` : null;
    if (!providerId || amountCents === null || !subjectId) return null;
    return {
      brand,
      source: attributionFrom(payload),
      subjectId,
      subjectRef: email || null,
      amountCents,
      eventKey: `shopify:order:${providerId}`,
      metadata: { provider: 'shopify', lineItems: (payload.line_items || []).length },
    };
  }

  if (source === 'stripe') {
    const details = payload.customer_details || {};
    const email = details.email || '';
    const providerId = payload.id;
    // amount_total is cents; `amount` is the older single-charge field.
    const amountCents =
      payload.amount_total != null ? centsFromCents(payload.amount_total) : unitsToCents(payload.amount);
    const subjectId = payload.customer ? `stripe:customer:${payload.customer}` : email ? `stripe:email:${email.toLowerCase()}` : null;
    if (!providerId || amountCents === null || !subjectId) return null;
    return {
      brand,
      source: attributionFrom(payload),
      subjectId,
      subjectRef: email || null,
      amountCents,
      eventKey: `stripe:order:${providerId}`,
      metadata: { provider: 'stripe' },
    };
  }

  return null;
}

/**
 * Attribution, best effort. An unrecognised value normalises to 'unknown'
 * downstream rather than being dropped, so a new UTM never costs us the sale.
 */
function attributionFrom(payload = {}) {
  const raw = String(
    payload.source_name || payload.referring_site || payload.utm_source || payload.metadata?.utm_source || ''
  ).toLowerCase();
  if (!raw) return 'direct';
  if (raw.includes('affiliate')) return 'affiliate';
  if (raw.includes('facebook') || raw.includes('instagram') || raw.includes('meta')) return 'paid_meta';
  if (raw.includes('google')) return 'paid_google';
  if (raw.includes('tiktok')) return 'paid_tiktok';
  if (raw === 'web' || raw === 'shopify_draft_order') return 'direct';
  return raw;
}

/**
 * Record a completed order.
 *
 * `store` is injected so this is testable without Postgres and so the caller
 * controls the connection. It must expose record() and hasPriorPurchase().
 *
 * Whether this is a first or repeat purchase is looked up, not guessed: the
 * taxonomy separates them and reporting repeat revenue depends on getting it
 * right. If the lookup fails we fall back to purchase_completed rather than
 * inventing a repeat.
 */
async function emitOrder({ source, payload, brandKey, occurredAt, store }) {
  try {
    const described = describeOrder(source, payload, { brandKey });
    if (!described) return { emitted: false, reason: 'unusable_payload' };

    let isRepeat = false;
    try {
      isRepeat = await store.hasPriorPurchase(described.subjectId);
    } catch {
      isRepeat = false; // conservative: a first purchase is the safer default
    }

    const { event, duplicate } = await store.record({
      ...described,
      type: isRepeat ? 'repeat_purchase' : 'purchase_completed',
      occurredAt: occurredAt || new Date(),
    });

    return { emitted: true, duplicate, type: event.type, amountCents: event.amountCents };
  } catch (error) {
    // Never propagate: an analytics write must not fail an order.
    return { emitted: false, reason: 'error', message: error.message };
  }
}

/** Record a coaching close (Beauty's parallel funnel). */
async function emitCoachingClose({ subscription = {}, occurredAt, store }) {
  try {
    const amountCents = centsFromCents(subscription.amountCents ?? subscription.amount_cents);
    const subscriptionId = subscription.subscriptionId || subscription.subscription_id;
    if (!subscriptionId || amountCents === null) return { emitted: false, reason: 'unusable_subscription' };

    const { event, duplicate } = await store.record({
      type: 'coaching_close',
      brand: 'beauty',
      source: 'unknown',
      subjectId: `stripe:subscription:${subscriptionId}`,
      amountCents,
      eventKey: `stripe:subscription:${subscriptionId}:active`,
      occurredAt: occurredAt || new Date(),
      metadata: { provider: 'stripe' },
    });
    return { emitted: true, duplicate, type: event.type };
  } catch (error) {
    return { emitted: false, reason: 'error', message: error.message };
  }
}

/** Record that a governed outreach email actually went out. */
async function emitWelcomeSent({ subjectId, subjectRef, brand = 'wellness', source = 'unknown', messageId, occurredAt, store }) {
  try {
    if (!subjectId || !messageId) return { emitted: false, reason: 'missing_identity' };
    const { event, duplicate } = await store.record({
      type: 'welcome_email_sent',
      brand,
      source,
      subjectId,
      subjectRef: subjectRef || null,
      eventKey: `welcome:${messageId}`,
      occurredAt: occurredAt || new Date(),
    });
    return { emitted: true, duplicate, type: event.type };
  } catch (error) {
    return { emitted: false, reason: 'error', message: error.message };
  }
}

/** Validate without writing — used by tests and by callers doing a dry run. */
function previewOrderEvent(source, payload, { brandKey = 'wellness', isRepeat = false } = {}) {
  const described = describeOrder(source, payload, { brandKey });
  if (!described) return null;
  return buildEvent({ ...described, type: isRepeat ? 'repeat_purchase' : 'purchase_completed' });
}

module.exports = {
  describeOrder,
  attributionFrom,
  unitsToCents,
  centsFromCents,
  emitOrder,
  emitCoachingClose,
  emitWelcomeSent,
  previewOrderEvent,
};

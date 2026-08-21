'use strict';

// Turn a paid Stripe event into coaching access.
//
// The provisioning step is deliberately tiny, because the repo already does
// the hard parts: creating a coaching client triggers the invite email
// automatically (lib/coaching/invite-email-bootstrap.js patches createClient),
// so "grant access" really is one call.
//
// Two properties matter more than anything else here:
//
//   1. Unsigned events are never trusted. Anyone can POST to a public webhook
//      URL; without signature verification a stranger could mint themselves
//      free coaching access by forging a checkout.session.completed.
//   2. Provisioning is idempotent. Stripe retries deliveries, and the same
//      event arriving twice must not create two clients or send two invites.

const crypto = require('crypto');

// Stripe's default replay window.
const DEFAULT_TOLERANCE_SECONDS = 300;

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verify a Stripe webhook signature.
 *
 * Same construction as the integration gateway's verifyStripe(), kept as a
 * pure function of its inputs so it can be tested directly.
 *
 * @param {object} input
 * @param {Buffer|string} input.rawBody - the exact bytes Stripe posted
 * @param {string} input.signatureHeader - the `stripe-signature` header
 * @param {string} input.secret - STRIPE_WEBHOOK_SECRET
 * @param {number} [input.nowSeconds]
 * @param {number} [input.toleranceSeconds]
 * @returns {boolean}
 */
function verifyStripeSignature({
  rawBody,
  signatureHeader,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
} = {}) {
  if (!secret) return false;
  const parts = String(signatureHeader || '').split(',');
  const timestamp = Number(parts.find((part) => part.trim().startsWith('t='))?.trim().slice(2));
  const signatures = parts
    .filter((part) => part.trim().startsWith('v1='))
    .map((part) => part.trim().slice(3));
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  if (signatures.length === 0) return false;

  const signedPayload = `${timestamp}.${Buffer.from(rawBody || '').toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return signatures.some((signature) => safeEqual(signature, expected));
}

/** Split a full name into the first/last the coaching store expects. */
function splitName(fullName) {
  const cleaned = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return { firstName: '', lastName: '' };
  const parts = cleaned.split(' ');
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Pull the details needed to provision access out of a Stripe event.
 *
 * Pure. Returns null when the event is not one that should grant access, so
 * the caller can acknowledge it without doing anything.
 *
 * @param {object} event - a parsed Stripe event
 * @returns {null|{email: string, firstName: string, lastName: string,
 *   subscriptionId: string|null, eventId: string|null}}
 */
function extractProvisioning(event) {
  if (!event || event.type !== 'checkout.session.completed') return null;
  const session = event.data?.object || {};
  const email =
    session.customer_details?.email ||
    session.customer_email ||
    '';
  if (!email) return null;

  const { firstName, lastName } = splitName(session.customer_details?.name);
  return {
    email: String(email).trim().toLowerCase(),
    // The coaching store requires a first name; fall back to the local part of
    // the address rather than rejecting a paying customer over a blank field.
    firstName: firstName || String(email).split('@')[0],
    lastName,
    subscriptionId: session.subscription ? String(session.subscription) : null,
    eventId: event.id ? String(event.id) : null
  };
}

/**
 * Grant coaching access for a paid checkout.
 *
 * Creating the client is what sends the invite email, so this single call is
 * the whole "customer paid -> customer can log in" step.
 *
 * @param {object} input
 * @param {object} input.event - verified Stripe event
 * @param {object} input.store - a coaching store
 * @returns {Promise<{status: 'provisioned'|'ignored'|'already_provisioned'|'failed',
 *   email?: string, detail?: string}>}
 */
async function provisionFromEvent({ event, store } = {}) {
  const details = extractProvisioning(event);
  if (!details) return { status: 'ignored' };
  if (!store || typeof store.createClient !== 'function') {
    return { status: 'failed', detail: 'coaching store is unavailable' };
  }

  try {
    await store.createClient({
      email: details.email,
      firstName: details.firstName,
      lastName: details.lastName,
      subscriptionId: details.subscriptionId,
      profile: { source: 'stripe_checkout', stripeEventId: details.eventId }
    });
    return { status: 'provisioned', email: details.email };
  } catch (error) {
    // The store throws a 409 conflict when the email already exists. Stripe
    // retries webhooks, and a customer may resubscribe, so an existing client
    // is the expected outcome of a redelivery — not a failure.
    if (error?.statusCode === 409 || error?.code === '23505') {
      return { status: 'already_provisioned', email: details.email };
    }
    return { status: 'failed', email: details.email, detail: String(error?.message || error).slice(0, 300) };
  }
}

// What each billing event should do to a client's access.
//
// The shape of this map is a judgement about dunning, not a technicality. A
// failed payment does NOT cut access: Stripe retries a card over several days,
// and locking someone out on the first failure punishes a customer whose card
// simply expired. It marks them at risk so the coach can reach out. Access
// ends only when the subscription is actually gone.
//
// 'archived' is the status the session layer refuses (see getSession in
// lib/coaching/store.js); 'paused' is visible to the coach but still allows
// login, which is exactly what "at risk" should mean.
const LIFECYCLE = new Map([
  ['customer.subscription.deleted', { intent: 'revoke', status: 'archived' }],
  ['invoice.payment_failed', { intent: 'at_risk', status: 'paused' }],
  ['invoice.payment_action_required', { intent: 'at_risk', status: 'paused' }],
  ['invoice.paid', { intent: 'restore', status: 'active' }],
  ['invoice.payment_succeeded', { intent: 'restore', status: 'active' }]
]);

/**
 * Read the subscription lifecycle instruction out of an event.
 *
 * Pure. Returns null for events that should not change access at all.
 */
function extractLifecycle(event) {
  if (!event) return null;
  const rule = LIFECYCLE.get(event.type);
  if (!rule) return null;

  const object = event.data?.object || {};
  // invoices carry `subscription`; subscription events are the object itself.
  const subscriptionId = object.subscription || object.id || null;
  if (!subscriptionId) return null;

  return {
    subscriptionId: String(subscriptionId),
    intent: rule.intent,
    status: rule.status,
    eventType: event.type
  };
}

/**
 * Apply a billing event to a client's access.
 *
 * @returns {Promise<{status: 'ignored'|'unmatched'|'unchanged'|'applied'|'failed',
 *   intent?: string, clientStatus?: string, clientId?: string, detail?: string}>}
 */
async function applyLifecycle({ event, store } = {}) {
  const instruction = extractLifecycle(event);
  if (!instruction) return { status: 'ignored' };
  if (!store || typeof store.findClientBySubscriptionId !== 'function') {
    return { status: 'failed', detail: 'coaching store cannot look up subscriptions' };
  }

  try {
    const client = await store.findClientBySubscriptionId(instruction.subscriptionId);
    // A subscription with no client is normal: it may predate the coaching
    // app, or belong to a different product entirely.
    if (!client) return { status: 'unmatched', intent: instruction.intent };

    // Never resurrect a client the coach archived by hand just because a
    // stray invoice arrived.
    if (instruction.intent === 'restore' && client.status === 'active') {
      return { status: 'unchanged', intent: instruction.intent, clientId: client.clientId };
    }
    if (client.status === instruction.status) {
      return { status: 'unchanged', intent: instruction.intent, clientId: client.clientId };
    }

    await store.setClientStatus(client.clientId, instruction.status, instruction.eventType);
    return {
      status: 'applied',
      intent: instruction.intent,
      clientStatus: instruction.status,
      clientId: client.clientId
    };
  } catch (error) {
    return { status: 'failed', detail: String(error?.message || error).slice(0, 300) };
  }
}

module.exports = {
  verifyStripeSignature,
  extractProvisioning,
  provisionFromEvent,
  extractLifecycle,
  applyLifecycle,
  splitName,
  LIFECYCLE,
  DEFAULT_TOLERANCE_SECONDS
};

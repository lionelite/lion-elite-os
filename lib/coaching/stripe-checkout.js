'use strict';

// Stripe Checkout for Lion Elite coaching.
//
// This is the half of the payment loop the repo was missing. Everything
// downstream already existed — lib/postgres-subscription-store.js records
// paid events, and lib/coaching/invite-email-bootstrap.js emails an invite the
// moment a client row is created — but nothing anywhere could actually charge
// a card, so the finished coaching product could not be bought.
//
// Deliberate choices:
//
//   * No `stripe` npm dependency. The repo already talks to Resend over plain
//     fetch (lib/email-delivery.js, lib/coaching/invite-email.js); matching
//     that keeps the dependency list and the Render build unchanged.
//   * The PRICE is never defined here. It lives in the Stripe dashboard and is
//     referenced by id, so what a customer is charged stays an owner decision
//     that no code change can quietly alter.
//   * Fail closed. Missing configuration returns a clear "not configured"
//     result rather than a broken checkout page or a fake success.

const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Read Stripe configuration from the environment.
 *
 * @returns {{secretKey: string, priceId: string, enabled: boolean,
 *   missing: string[]}} `enabled` is only true when a charge could really be
 *   created; `missing` names what the owner still has to set in Render.
 */
function resolveCheckoutConfig(env = process.env) {
  const secretKey = String(env.STRIPE_SECRET_KEY || '').trim();
  const priceId = String(env.STRIPE_PRICE_ID || '').trim();
  const missing = [];
  if (!secretKey) missing.push('STRIPE_SECRET_KEY');
  if (!priceId) missing.push('STRIPE_PRICE_ID');
  return { secretKey, priceId, enabled: missing.length === 0, missing };
}

/** Where Stripe sends the buyer back to, with a sensible production default. */
function publicBaseUrl(env = process.env) {
  return String(env.COACHING_PUBLIC_URL || 'https://lion-elite-os.onrender.com').replace(/\/$/, '');
}

/**
 * Build the form-encoded body for a Checkout Session.
 *
 * Pure, so the exact parameters sent to Stripe are testable without a network
 * call or an API key.
 *
 * @param {object} input
 * @param {string} input.priceId - Stripe Price id (price_...)
 * @param {string} input.baseUrl - public origin for the return URLs
 * @param {string} [input.email] - prefill; Stripe collects it otherwise
 * @param {string} [input.mode] - 'subscription' (default) or 'payment'
 * @returns {URLSearchParams}
 */
function buildCheckoutParams({ priceId, baseUrl, email = '', mode = 'subscription' } = {}) {
  if (!priceId) throw new TypeError('buildCheckoutParams requires a Stripe price id');
  if (!baseUrl) throw new TypeError('buildCheckoutParams requires a base URL');

  // Tolerate a trailing slash: this is also called with values that did not
  // come through publicBaseUrl(), and "//coaching/" is an ugly redirect.
  const origin = String(baseUrl).replace(/\/+$/, '');

  const params = new URLSearchParams();
  params.set('mode', mode);
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  // The buyer lands back on the coaching app, which will already have their
  // invite email waiting by the time they arrive.
  params.set('success_url', `${origin}/coaching/?checkout=success`);
  params.set('cancel_url', `${origin}/join/?checkout=cancelled`);
  // Needed to create the coaching client, and to email the invite.
  params.set('customer_creation', mode === 'payment' ? 'always' : 'if_required');
  params.set('billing_address_collection', 'auto');
  if (email) params.set('customer_email', email);
  return params;
}

/**
 * Create a Stripe Checkout Session and return the URL to send the buyer to.
 *
 * @returns {Promise<{ok: true, url: string, id: string}
 *   | {ok: false, reason: string, missing?: string[], detail?: string}>}
 */
async function createCheckoutSession({
  email = '',
  env = process.env,
  config = resolveCheckoutConfig(env),
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!config.enabled) {
    return { ok: false, reason: 'not_configured', missing: config.missing };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'fetch_unavailable' };
  }

  const params = buildCheckoutParams({
    priceId: config.priceId,
    baseUrl: publicBaseUrl(env),
    email
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(STRIPE_API, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Surface Stripe's own message — "No such price" is the single most
      // likely first-run failure and is worth reading verbatim.
      return {
        ok: false,
        reason: 'stripe_error',
        detail: String(payload?.error?.message || `HTTP ${response.status}`).slice(0, 300)
      };
    }
    if (!payload?.url) {
      return { ok: false, reason: 'stripe_error', detail: 'Stripe returned no checkout URL.' };
    }
    return { ok: true, url: payload.url, id: payload.id || null };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'network_error',
      detail: String(error?.message || error).slice(0, 300)
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  resolveCheckoutConfig,
  buildCheckoutParams,
  createCheckoutSession,
  publicBaseUrl,
  STRIPE_API
};

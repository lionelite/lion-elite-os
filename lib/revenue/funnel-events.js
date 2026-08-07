'use strict';

/**
 * Funnel event taxonomy for the automated revenue engine (Issue #89, P1).
 *
 * Every revenue-relevant thing that happens across the three brands lands here as
 * an append-only event, so the executive report can answer "where does money come
 * from and where does it stall" without each subsystem inventing its own counters.
 *
 * Two deliberate constraints:
 *
 * 1. The stage list is CLOSED. An unknown event type throws instead of being
 *    recorded. A typo that silently creates a new funnel stage is worse than a
 *    crash — it produces a report that looks fine and is wrong, which is exactly
 *    how a green dashboard hides a dead pipeline.
 * 2. No PII. Events carry an opaque `subjectId` and a salted hash, never an email
 *    or a phone number. Revenue analytics does not need identity, and keeping it
 *    out means this table can be queried and exported freely.
 *
 * Pure functions only — no database, no Redis — so the taxonomy and the funnel
 * maths are unit-testable without infrastructure. Persistence lives in
 * lib/revenue/funnel-store.js.
 */

const crypto = require('crypto');

const BRANDS = Object.freeze(['wellness', 'beauty', 'alexthelionlifts']);

/**
 * Ordered acquisition funnel. Order matters: the report derives stage-to-stage
 * conversion by walking this list, so inserting a stage changes the maths.
 */
const FUNNEL_STAGES = Object.freeze([
  'lead_created',
  'consent_captured',
  'welcome_email_sent',
  'reply_received',
  'qualified',
  'offer_sent',
  'purchase_completed',
  'repeat_purchase',
]);

/**
 * Coaching runs a parallel funnel (Beauty), not a continuation of the product
 * funnel — someone can apply for coaching without ever buying a product, so
 * folding these into FUNNEL_STAGES would produce conversion rates over a
 * denominator that never applied.
 */
const COACHING_STAGES = Object.freeze(['coaching_application', 'coaching_close']);

const ALL_EVENT_TYPES = Object.freeze([...FUNNEL_STAGES, ...COACHING_STAGES]);

/** Events that represent money actually collected. */
const REVENUE_EVENTS = Object.freeze(['purchase_completed', 'repeat_purchase', 'coaching_close']);

const KNOWN_SOURCES = Object.freeze([
  'organic',
  'affiliate',
  'referral',
  'paid_meta',
  'paid_google',
  'paid_tiktok',
  'social_organic',
  'outreach_b2b',
  'outreach_b2c',
  'sms',
  'direct',
  'unknown',
]);

class FunnelEventError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FunnelEventError';
    this.code = code;
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Stable pseudonymous identifier. Salted with FUNNEL_HASH_SALT so the table is
 * not a rainbow-table lookup of the customer list; without a salt configured we
 * still hash, but callers should set one in production.
 */
function subjectHash(value, { salt = process.env.FUNNEL_HASH_SALT || '' } = {}) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(`${salt}:${normalized}`).digest('hex');
}

const PII_KEYS = /(^|_)(email|phone|first_?name|last_?name|full_?name|address|postal|zip|ip)($|_)/i;

/**
 * Metadata is free-form, which makes it the obvious place for PII to leak back
 * in. Reject the common carriers by key name rather than trusting every future
 * caller to remember.
 */
function assertNoPii(metadata) {
  for (const key of Object.keys(metadata)) {
    if (PII_KEYS.test(key)) {
      throw new FunnelEventError(
        `metadata key "${key}" looks like PII; funnel events store subjectId/subjectHash only`,
        'PII_IN_METADATA'
      );
    }
  }
}

/**
 * Validate and normalize a raw event into the exact shape the store persists.
 * Throws on anything it cannot vouch for — a rejected event is visible, a
 * silently coerced one is not.
 */
function buildEvent(input = {}) {
  if (!isPlainObject(input)) throw new FunnelEventError('event must be an object', 'INVALID_EVENT');

  const type = String(input.type || '').trim();
  if (!ALL_EVENT_TYPES.includes(type)) {
    throw new FunnelEventError(
      `unknown event type "${type}" (known: ${ALL_EVENT_TYPES.join(', ')})`,
      'UNKNOWN_EVENT_TYPE'
    );
  }

  const brand = String(input.brand || '').trim().toLowerCase();
  if (!BRANDS.includes(brand)) {
    throw new FunnelEventError(`unknown brand "${brand}" (known: ${BRANDS.join(', ')})`, 'UNKNOWN_BRAND');
  }

  // An unrecognised source is normalized to 'unknown' rather than rejected:
  // losing a whole conversion because an ad platform invented a new utm value
  // would be worse than reporting it as unattributed.
  const rawSource = String(input.source || '').trim().toLowerCase();
  const source = KNOWN_SOURCES.includes(rawSource) ? rawSource : 'unknown';

  const subjectId = String(input.subjectId || '').trim();
  if (!subjectId) throw new FunnelEventError('subjectId is required', 'MISSING_SUBJECT');

  let amountCents = null;
  if (input.amountCents !== undefined && input.amountCents !== null) {
    const n = Number(input.amountCents);
    if (!Number.isInteger(n) || n < 0) {
      throw new FunnelEventError('amountCents must be a non-negative integer', 'INVALID_AMOUNT');
    }
    amountCents = n;
  }
  if (REVENUE_EVENTS.includes(type) && amountCents === null) {
    throw new FunnelEventError(`${type} requires amountCents`, 'MISSING_AMOUNT');
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new FunnelEventError('occurredAt is not a valid date', 'INVALID_DATE');
  }

  const metadata = isPlainObject(input.metadata) ? { ...input.metadata } : {};
  assertNoPii(metadata);

  // Idempotency: the same logical event replayed (webhook retry, worker retry)
  // must not double-count revenue. Callers may pass an explicit key; otherwise
  // one is derived from the identifying tuple.
  const eventKey =
    String(input.eventKey || '').trim() ||
    crypto
      .createHash('sha256')
      .update([type, brand, subjectId, occurredAt.toISOString(), amountCents ?? ''].join('|'))
      .digest('hex');

  return {
    eventKey,
    type,
    brand,
    source,
    subjectId,
    subjectHash: input.subjectRef ? subjectHash(input.subjectRef) : null,
    amountCents,
    occurredAt,
    metadata,
  };
}

/** Convenience: does this event type belong to the ordered acquisition funnel? */
const isFunnelStage = (type) => FUNNEL_STAGES.includes(type);

module.exports = {
  BRANDS,
  FUNNEL_STAGES,
  COACHING_STAGES,
  ALL_EVENT_TYPES,
  REVENUE_EVENTS,
  KNOWN_SOURCES,
  FunnelEventError,
  buildEvent,
  subjectHash,
  isFunnelStage,
};

'use strict';

// B2C lead capture with consent evidence.
//
// The SMS pipeline reads smsConsent in three places and refuses to send without
// it. Nothing in the codebase wrote it, so the channel was inert by
// construction. This is the missing half: the point where a person gives
// consent, and the evidence that they did.
//
// Consent under TCPA is not a boolean someone sets on a record. It is prior
// express written consent you must be able to produce later: the exact wording
// shown, the moment of agreement, and where it came from. So this module
// refuses to record consent it cannot evidence, and the database refuses it
// again independently.
//
// Scraped or purchased contacts can never enter here. A number obtained without
// the person agreeing has no consent to record, and there is no field for a
// consent that did not happen.

const LANES = Object.freeze({
  'beauty-client': {
    lane: 'beauty-client',
    label: 'Consumer seeking coaching',
    brand: 'Lion Elite Beauty'
  },
  'coach-platform': {
    lane: 'coach-platform',
    label: 'Coach who needs a platform for their own clients',
    brand: 'Lion Elite Beauty'
  }
});

/** Minimum disclosure a person must be shown before SMS consent counts. */
const REQUIRED_SMS_DISCLOSURE_TERMS = ['msg', 'rates', 'stop'];

/**
 * The canonical SMS disclosure. Served to the opt-in page and stored with the
 * consent record, so what a person was shown and what we can later produce are
 * the same string by construction rather than by good intentions.
 *
 * It names the sender, discloses automated sending, states that consent is not
 * a condition of purchase, and gives frequency, rates and how to stop — the
 * elements prior express written consent is expected to carry.
 */
const SMS_DISCLOSURE = [
  'By checking this box you agree to receive recurring marketing text messages',
  'from Lion Elite at the number provided, including messages sent by automated',
  'means. Consent is not a condition of any purchase. Up to 4 msgs/month.',
  'Msg & data rates may apply. Reply STOP to opt out, HELP for help.'
].join(' ');

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeEmail(value) {
  const email = clean(value, 254).toLowerCase();
  // Deliberately simple: one @, something either side, a dot in the domain.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

/**
 * Normalize to E.164, which is what the SMS sender requires.
 * Returns '' when the input cannot be trusted as a real number rather than
 * guessing — a wrong number is a message to a stranger.
 */
function normalizePhone(value, defaultCountry = '1') {
  const raw = clean(value, 40);
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    const rest = digits.slice(1).replace(/\D/g, '');
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : '';
  }
  const bare = digits.replace(/\D/g, '');
  if (bare.length === 10) return `+${defaultCountry}${bare}`;
  if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`;
  return '';
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/**
 * Turn a submitted opt-in form into a row, or refuse it.
 *
 * @param {object} input        the submitted fields
 * @param {object} context      { ip, userAgent, now } observed server-side
 */
function buildCapture(input = {}, context = {}) {
  const lane = clean(input.lane, 40);
  if (!LANES[lane]) {
    throw badRequest(`lane must be one of: ${Object.keys(LANES).join(', ')}`);
  }

  const email = normalizeEmail(input.email);
  if (!email) throw badRequest('A valid email address is required.');

  const phone = normalizePhone(input.phone);
  if (clean(input.phone) && !phone) {
    throw badRequest('That phone number could not be read as a valid number.');
  }

  const now = context.now ? new Date(context.now) : new Date();
  const timestamp = now.toISOString();

  // Consent must be an affirmative act. A missing field is not consent, and
  // neither is a truthy string — only an explicit true, which in practice means
  // an unchecked-by-default box the person ticked themselves.
  const emailConsent = input.emailMarketingConsent === true;
  const smsConsent = input.smsMarketingConsent === true;

  if (smsConsent) {
    if (!phone) {
      throw badRequest('SMS consent requires a phone number.');
    }
    const disclosure = clean(input.smsConsentText, 1000);
    if (!disclosure) {
      throw badRequest('SMS consent requires the exact disclosure the person agreed to.');
    }
    const lowered = disclosure.toLowerCase();
    const missing = REQUIRED_SMS_DISCLOSURE_TERMS.filter(term => !lowered.includes(term));
    if (missing.length) {
      throw badRequest(
        `The SMS disclosure is missing required elements (${missing.join(', ')}). ` +
        'It must state message frequency, that message and data rates may apply, and how to stop.'
      );
    }
  }

  return {
    lane,
    name: clean(input.name, 120),
    email,
    phone: phone || null,
    source: clean(input.source, 80) || 'unknown',
    status: 'new',
    emailMarketingConsent: emailConsent,
    emailConsentAt: emailConsent ? timestamp : null,
    smsMarketingConsent: smsConsent,
    smsConsentAt: smsConsent ? timestamp : null,
    smsConsentText: smsConsent ? clean(input.smsConsentText, 1000) : null,
    // Observed server-side, never accepted from the submitted body: a
    // self-reported origin is not evidence of anything.
    smsConsentIp: smsConsent ? clean(context.ip, 64) || null : null,
    smsConsentUserAgent: smsConsent ? clean(context.userAgent, 400) || null : null
  };
}

module.exports = {
  LANES,
  SMS_DISCLOSURE,
  buildCapture,
  normalizeEmail,
  normalizePhone,
  REQUIRED_SMS_DISCLOSURE_TERMS
};

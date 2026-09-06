'use strict';

// Signed unsubscribe links.
//
// The link has to work for someone who is annoyed, on a phone, and not signed
// in — so it carries its own proof. A signature stops an address being used to
// enumerate the list or to unsubscribe strangers in bulk.
//
// It deliberately does NOT fail closed. An unsubscribe that refuses to run
// because a secret is unset or a signature has drifted is a CAN-SPAM problem,
// not a security win: the law requires a working opt-out. So an unsigned link
// still unsubscribes; the signature only tells us whether to trust the request
// beyond that single address.

const crypto = require('node:crypto');

function secret() {
  return String(process.env.UNSUBSCRIBE_SECRET || '').trim();
}

function sign(email) {
  const key = secret();
  if (!key) return '';
  return crypto
    .createHmac('sha256', key)
    .update(String(email || '').trim().toLowerCase())
    .digest('base64url');
}

/**
 * @returns {'signed'|'unsigned'|'invalid'} how much the request is trusted.
 *   'invalid' still unsubscribes that one address — it just is not treated as
 *   proof of anything.
 */
function verify(email, token) {
  const expected = sign(email);
  const supplied = String(token || '').trim();
  if (!expected) return 'unsigned';
  if (!supplied) return 'unsigned';
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length) return 'invalid';
  return crypto.timingSafeEqual(a, b) ? 'signed' : 'invalid';
}

/** Build the URL that goes into an email footer. */
function unsubscribeUrl(email, baseUrl = process.env.PUBLIC_BASE_URL || '') {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const params = new URLSearchParams({ email: String(email || '').trim().toLowerCase() });
  const token = sign(email);
  if (token) params.set('t', token);
  return `${base}/unsubscribe/?${params.toString()}`;
}

module.exports = { sign, verify, unsubscribeUrl };

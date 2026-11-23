'use strict';

/**
 * Addresses and organisations that automation must never e-mail, whatever
 * their stage, campaign or qualification says.
 *
 * Owner decision (2026-11-10):
 *   - Level T (info@thelevelt.com) replied. A human owns that conversation, so
 *     no automated message goes to anyone at that organisation.
 *   - asim.hasnie@intechaero.com is never e-mailed.
 *
 * These are deliberately code constants and not only an env var: they only
 * ever make sending MORE restrictive, and an exclusion that disappears when
 * someone mistypes an env var is not an exclusion. OUTREACH_NEVER_EMAIL
 * (comma-separated addresses or bare domains) adds to the list; nothing
 * removes from it.
 *
 * Checked when picking who to send to AND again immediately before each send.
 */
const NEVER_EMAIL_ADDRESSES = Object.freeze([
  'info@thelevelt.com',
  'asim.hasnie@intechaero.com',
]);

// Organisation-level blocks. Level T replied, so nobody there gets an automated
// message while that thread is with a person.
const NEVER_EMAIL_DOMAINS = Object.freeze([
  'thelevelt.com',
]);

function normalise(value) {
  return String(value || '').trim().toLowerCase();
}

function neverEmailList(env = process.env) {
  const extra = String(env.OUTREACH_NEVER_EMAIL || '').split(',').map(normalise).filter(Boolean);
  return {
    addresses: [...NEVER_EMAIL_ADDRESSES, ...extra.filter(v => v.includes('@'))],
    domains: [...NEVER_EMAIL_DOMAINS, ...extra.filter(v => !v.includes('@'))],
  };
}

/** @returns {string|null} the reason the address is blocked, or null. */
function neverEmailReason(email, env = process.env) {
  const address = normalise(email);
  if (!address) return null;
  const domain = address.includes('@') ? address.split('@').pop() : '';
  const list = neverEmailList(env);
  if (list.addresses.includes(address)) return `${address} is on the never-email list`;
  const blockedDomain = list.domains.find(d => domain === d || domain.endsWith(`.${d}`));
  if (blockedDomain) return `${blockedDomain} is on the never-email list`;
  return null;
}

function isNeverEmail(email, env = process.env) {
  return neverEmailReason(email, env) !== null;
}

module.exports = { NEVER_EMAIL_ADDRESSES, NEVER_EMAIL_DOMAINS, neverEmailList, neverEmailReason, isNeverEmail };

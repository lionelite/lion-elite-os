'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = 'lion_coaching_session';

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function secureEquals(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(Buffer.alloc(Math.max(left.length, 1)), Buffer.alloc(Math.max(left.length, 1)));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header = '') {
  return String(header)
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)
    .reduce((cookies, pair) => {
      const separator = pair.indexOf('=');
      if (separator < 1) return cookies;
      const key = decodeURIComponent(pair.slice(0, separator));
      const value = decodeURIComponent(pair.slice(separator + 1));
      cookies[key] = value;
      return cookies;
    }, {});
}

function isSecureRequest(req) {
  return Boolean(
    req.secure ||
    String(req.get?.('x-forwarded-proto') || '').split(',')[0].trim() === 'https' ||
    process.env.NODE_ENV === 'production'
  );
}

function sessionCookie(req, token, maxAgeSeconds = 60 * 60 * 24 * 30) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/api/coaching',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (isSecureRequest(req)) attributes.push('Secure');
  return attributes.join('; ');
}

function clearSessionCookie(req) {
  return sessionCookie(req, '', 0);
}

function assertSameOrigin(req) {
  if (String(req.get?.('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
    const error = new Error('Cross-site request blocked.');
    error.statusCode = 403;
    throw error;
  }

  const origin = req.get?.('origin');
  if (!origin) return;
  const forwardedProto = String(req.get?.('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const expectedOrigin = `${protocol}://${req.get('host')}`;
  if (!secureEquals(origin, expectedOrigin)) {
    const error = new Error('Request origin is not allowed.');
    error.statusCode = 403;
    throw error;
  }
}

function sessionTokenFromRequest(req) {
  return parseCookies(req.get?.('cookie') || '')[SESSION_COOKIE] || '';
}

module.exports = {
  SESSION_COOKIE,
  assertSameOrigin,
  clearSessionCookie,
  generateToken,
  hashToken,
  parseCookies,
  secureEquals,
  sessionCookie,
  sessionTokenFromRequest
};

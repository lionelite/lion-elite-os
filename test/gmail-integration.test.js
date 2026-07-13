'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOAuthState, verifyOAuthState, encryptToken, decryptToken,
  buildAuthorizationUrl, normalizeMessage
} = require('../lib/gmail-integration');

test('OAuth state is signed, expires, and rejects tampering', () => {
  const secret = 'state-secret';
  const state = createOAuthState(secret, 1_000);
  assert.equal(verifyOAuthState(state, secret, 2_000), true);
  assert.equal(verifyOAuthState(`${state}x`, secret, 2_000), false);
  assert.equal(verifyOAuthState(state, secret, 1_000 + 11 * 60 * 1000), false);
});

test('token encryption round trips and rejects the wrong key', () => {
  const encrypted = encryptToken('refresh-token-value', 'encryption-secret');
  assert.equal(encrypted.includes('refresh-token-value'), false);
  assert.equal(decryptToken(encrypted, 'encryption-secret'), 'refresh-token-value');
  assert.throws(() => decryptToken(encrypted, 'wrong-secret'));
});

test('authorization URL uses offline consent and least privilege read scope', () => {
  const url = new URL(buildAuthorizationUrl({ clientId: 'client', redirectUri: 'https://example.com/oauth/google/callback' }, 'signed-state'));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.match(url.searchParams.get('scope'), /gmail\.readonly/);
  assert.doesNotMatch(url.searchParams.get('scope'), /gmail\.send/);
});

test('Gmail metadata normalizes addresses and reply identifiers', () => {
  const normalized = normalizeMessage({
    id: 'gmail-1', threadId: 'thread-1', historyId: '99', internalDate: '1000', snippet: 'Thanks',
    payload: { headers: [
      { name: 'From', value: 'Prospect <Person@Example.com>' },
      { name: 'To', value: 'Lion <info@lionelitewellness.com>' },
      { name: 'Subject', value: 'Re: Coaching' },
      { name: 'Message-ID', value: '<message@example.com>' },
      { name: 'In-Reply-To', value: '<original@example.com>' }
    ] }
  });
  assert.equal(normalized.from, 'person@example.com');
  assert.equal(normalized.to, 'info@lionelitewellness.com');
  assert.equal(normalized.inReplyTo, '<original@example.com>');
});

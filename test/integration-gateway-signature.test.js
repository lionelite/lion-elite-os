'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.AFFILIATE_WEBHOOK_SECRET = process.env.AFFILIATE_WEBHOOK_SECRET || 'test-affiliate-secret';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret';

const { verifySharedSecret, safeEqual, verifyStripe } = require('../integration-gateway-server');

function signedRequest(secret, body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, headers: { 'x-lion-signature': signature } };
}

test('safeEqual rejects mismatched-length and mismatched-content values', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'xyz'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
});

test('verifySharedSecret accepts a correctly signed affiliate webhook payload', () => {
  const req = signedRequest('test-affiliate-secret', { organization: 'Synthetic Academy' });
  assert.equal(verifySharedSecret(req, 'AFFILIATE_WEBHOOK_SECRET'), true);
});

test('verifySharedSecret rejects an unsigned or incorrectly signed payload', () => {
  const unsigned = { rawBody: Buffer.from(JSON.stringify({ organization: 'Synthetic Academy' })), headers: {} };
  assert.equal(verifySharedSecret(unsigned, 'AFFILIATE_WEBHOOK_SECRET'), false);

  const wrongSecret = signedRequest('not-the-real-secret', { organization: 'Synthetic Academy' });
  assert.equal(verifySharedSecret(wrongSecret, 'AFFILIATE_WEBHOOK_SECRET'), false);
});

test('verifySharedSecret fails closed when the env secret is not configured', () => {
  const req = signedRequest('anything', { organization: 'Synthetic Academy' });
  assert.equal(verifySharedSecret(req, 'SOME_UNSET_WEBHOOK_SECRET'), false);
});

test('verifyStripe accepts a current Stripe v1 signature over the exact raw body', () => {
  const timestamp = 1_800_000_000;
  const rawBody = Buffer.from(JSON.stringify({ id: 'evt_synthetic', type: 'invoice.paid' }));
  const signature = crypto.createHmac('sha256', 'whsec_test_secret')
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  const req = { rawBody, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` } };
  assert.equal(verifyStripe(req, timestamp), true);
});

test('verifyStripe rejects stale, tampered, and unconfigured signatures', () => {
  const timestamp = 1_800_000_000;
  const rawBody = Buffer.from('{"id":"evt_synthetic"}');
  const signature = crypto.createHmac('sha256', 'whsec_test_secret')
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  assert.equal(verifyStripe({ rawBody, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` } }, timestamp + 301), false);
  assert.equal(verifyStripe({ rawBody: Buffer.from('{}'), headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` } }, timestamp), false);
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal(verifyStripe({ rawBody, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` } }, timestamp), false);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
});

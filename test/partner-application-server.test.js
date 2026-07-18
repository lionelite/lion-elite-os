'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeApplication } = require('../partner-application-server');

test('normalizes an affiliate application for the existing affiliate webhook intake', () => {
  const result = normalizeApplication({
    program: 'affiliate',
    firstName: 'Alex',
    lastName: 'Partner',
    email: ' ALEX@EXAMPLE.COM ',
    organization: 'Creator Lab',
    website: 'https://example.com',
    audienceEstimate: '25000',
    territory: 'Florida'
  });

  assert.equal(result.type, 'affiliate_application');
  assert.equal(result.program, 'affiliate');
  assert.equal(result.email, 'alex@example.com');
  assert.equal(result.organization, 'Creator Lab');
  assert.equal(result.campaign, 'affiliate_applications');
  assert.ok(result.submittedAt);
});

test('normalizes wholesale applications into a distinct campaign while using the shared partner intake', () => {
  const result = normalizeApplication({
    program: 'wholesale',
    firstName: 'Wholesale',
    lastName: 'Buyer',
    email: 'buyer@example.com',
    businessType: 'Laboratory',
    monthlyVolume: 'Recurring monthly orders'
  });

  assert.equal(result.type, 'wholesale_application');
  assert.equal(result.program, 'wholesale');
  assert.equal(result.organization, 'Wholesale Buyer');
  assert.equal(result.campaign, 'wholesale_applications');
});

test('rejects unsupported program types and invalid emails', () => {
  assert.throws(
    () => normalizeApplication({ program: 'other', email: 'a@example.com', organization: 'A' }),
    /choose affiliate or wholesale/i
  );
  assert.throws(
    () => normalizeApplication({ program: 'affiliate', email: 'not-an-email', organization: 'A' }),
    /valid email/i
  );
});

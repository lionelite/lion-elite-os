'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhone,
  hasSmsMarketingConsent,
  buildEligibleRecipients,
  renderMessage
} = require('../lib/sms-outreach');

test('normalizes US phone numbers', () => {
  assert.equal(normalizePhone('(305) 555-1212'), '+13055551212');
  assert.equal(normalizePhone('1-305-555-1212'), '+13055551212');
  assert.equal(normalizePhone('+442071838750'), '+442071838750');
  assert.equal(normalizePhone('123'), null);
});

test('requires explicit SMS marketing consent', () => {
  assert.equal(hasSmsMarketingConsent({ sms_marketing_consent: { state: 'subscribed' } }), true);
  assert.equal(hasSmsMarketingConsent({ smsMarketingConsent: { marketingState: 'CONFIRMED_OPT_IN' } }), true);
  assert.equal(hasSmsMarketingConsent({ sms_marketing_consent: { state: 'not_subscribed' } }), false);
  assert.equal(hasSmsMarketingConsent({}), false);
});

test('filters to recent, consented customers and deduplicates by phone', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const orders = [
    {
      id: 1,
      created_at: '2026-07-10T12:00:00Z',
      customer: { first_name: 'Makia', phone: '(305) 555-1111', sms_marketing_consent: { state: 'subscribed' } }
    },
    {
      id: 2,
      created_at: '2026-07-15T12:00:00Z',
      customer: { first_name: 'Makia', phone: '+13055551111', sms_marketing_consent: { state: 'subscribed' } }
    },
    {
      id: 3,
      created_at: '2026-07-11T12:00:00Z',
      customer: { first_name: 'No Consent', phone: '+13055552222', sms_marketing_consent: { state: 'not_subscribed' } }
    },
    {
      id: 4,
      created_at: '2026-04-01T12:00:00Z',
      customer: { first_name: 'Old', phone: '+13055553333', sms_marketing_consent: { state: 'subscribed' } }
    }
  ];

  const result = buildEligibleRecipients(orders, { days: 45, now });
  assert.equal(result.recipients.length, 1);
  assert.equal(result.recipients[0].orderId, 2);
  assert.equal(result.skipped.length, 2);
});

test('personalizes the first name', () => {
  assert.equal(renderMessage('Hi {{firstName}}!', { firstName: 'Alex' }), 'Hi Alex!');
});

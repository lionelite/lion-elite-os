'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, classify } = require('../lib/integration-normalization');

test('classifies an affiliate application as an affiliate_lead', () => {
  assert.equal(classify('affiliate', 'affiliate_application', {}), 'affiliate_lead');
});

test('summarizes an affiliate application payload without leaking unexpected fields', () => {
  const payload = {
    organization: 'Synthetic Trainer Academy',
    email: 'partnerships@example-academy.test',
    country: 'Testland',
    website: 'https://example-academy.test',
    audienceEstimate: 500,
    territory: 'INTERNATIONAL_REMOTE',
    campaign: 'affiliate_applications_test'
  };
  const summary = summarize('affiliate', 'affiliate_application', payload);
  assert.deepEqual(summary, {
    organization: 'Synthetic Trainer Academy',
    email: 'partnerships@example-academy.test',
    country: 'Testland',
    website: 'https://example-academy.test',
    audienceEstimate: 500,
    territory: 'INTERNATIONAL_REMOTE',
    campaign: 'affiliate_applications_test'
  });
});

test('summarize falls back to null fields for a sparse affiliate payload', () => {
  const summary = summarize('affiliate', 'affiliate_application', {});
  assert.equal(summary.organization, null);
  assert.equal(summary.email, null);
  assert.equal(summary.territory, null);
});

test('existing classify behavior for shopify/gmail/calendar/ads is unchanged', () => {
  assert.equal(classify('shopify', 'orders/create', { total_price: '10.00' }), 'revenue');
  assert.equal(classify('gmail', 'message', {}), 'lead_or_support');
  assert.equal(classify('calendar', 'event', {}), 'appointment');
  assert.equal(classify('ads', 'performance', {}), 'marketing_performance');
  assert.equal(classify('unknown-source', 'unknown', {}), 'general');
});

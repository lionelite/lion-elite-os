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

test('normalizes Stripe subscription revenue without retaining the full provider payload', () => {
  const payload = {
    id: 'evt_synthetic_paid', created: 1790000000,
    type: 'invoice.paid',
    data: { object: {
      id: 'in_synthetic', subscription: 'sub_synthetic', customer: 'cus_synthetic',
      customer_email: 'synthetic@example.test', amount_paid: 29999, currency: 'USD',
      lines: { data: [{ period: { end: 1800000000 } }] },
      metadata: { program: 'lion_elite_beauty_basic', internal_note: 'must-not-survive' }
    }}
  };
  const summary = summarize('stripe', 'invoice.paid', payload);
  assert.deepEqual(summary, {
    subscriptionId: 'sub_synthetic', customerId: 'cus_synthetic', customerEmail: 'synthetic@example.test',
    status: 'active', amountCents: 29999, currency: 'usd',
    currentPeriodEnd: new Date(1800000000 * 1000).toISOString(), cancelAtPeriodEnd: false,
    program: 'lion_elite_beauty_basic', eventCreatedAt: new Date(1790000000 * 1000).toISOString()
  });
  assert.equal(JSON.stringify(summary).includes('must-not-survive'), false);
  assert.equal(classify('stripe', 'invoice.paid', payload), 'subscription_revenue');
});

test('classifies failed Stripe subscription payments as retention risk', () => {
  const payload = { data: { object: { subscription: 'sub_synthetic', amount_due: 29999, currency: 'usd' } } };
  const summary = summarize('stripe', 'invoice.payment_failed', payload);
  assert.equal(summary.status, 'past_due');
  assert.equal(classify('stripe', 'invoice.payment_failed', payload), 'retention_risk');
});

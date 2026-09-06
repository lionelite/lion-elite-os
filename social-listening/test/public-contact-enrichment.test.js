'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractUrls,
  extractEmails,
  extractPhones,
  isPrivateIp,
  enrichPublicContact
} = require('../src/public-contact-enrichment');

test('extracts public URLs from profile text', () => {
  assert.deepEqual(
    extractUrls('Coach applications: https://example.com/apply and www.example.org/contact'),
    ['https://example.com/apply', 'https://www.example.org/contact']
  );
});

test('extracts direct and obfuscated public emails', () => {
  const emails = extractEmails('Email coach@example.com or sales [at] example [dot] org');
  assert.deepEqual(emails, ['coach@example.com', 'sales@example.org']);
});

test('normalizes North American public phone numbers', () => {
  const phones = extractPhones('Business: (305) 555-1212 or tel:+1-786-555-9999');
  assert.deepEqual(phones, ['+13055551212', '+17865559999']);
});

test('blocks private network addresses from enrichment fetches', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.2.3.4'), true);
  assert.equal(isPrivateIp('192.168.1.10'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('profile contact discovery never becomes outreach consent', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      did: 'did:plc:test',
      handle: 'coach.test',
      displayName: 'Test Coach',
      description: 'Business inquiries: hello@coach.test | 305-555-1212'
    })
  });

  const result = await enrichPublicContact('did:plc:test', { fetchImpl });
  assert.deepEqual(result.publicEmails, ['hello@coach.test']);
  assert.deepEqual(result.publicPhones, ['+13055551212']);
  assert.equal(result.outreachConsent, false);
  assert.equal(result.outreachEligible, false);
  assert.equal(result.enrichmentPolicy, 'public_profile_and_linked_business_pages_only');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDomain,
  extractEmails,
  classifyEmail,
  discoverContactLinks,
  enrichBusinessEmail,
  enrichBatch
} = require('../lib/email-enrichment');

function response(url, html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html
  };
}

test('normalizes official business domains', () => {
  assert.equal(normalizeDomain('https://www.Example.com/contact'), 'example.com');
});

test('extracts and deduplicates visible emails', () => {
  assert.deepEqual(
    extractEmails('Email info@example.com or INFO@example.com.'),
    ['info@example.com']
  );
});

test('rejects third-party domain addresses', () => {
  const result = classifyEmail('info@gmail.com', 'example.com');
  assert.equal(result.eligible, false);
  assert.equal(result.domainMatch, false);
});

test('discovers same-origin contact links only', () => {
  const links = discoverContactLinks(
    '<a href="/contact">Contact</a><a href="https://other.com/contact">Other</a>',
    'https://example.com'
  );
  assert.deepEqual(links, ['https://example.com/contact']);
});

test('verifies a role inbox published on an official contact page', async () => {
  const pages = new Map([
    ['https://example.com/', response('https://example.com/', '<a href="/contact">Contact</a>')],
    ['https://example.com/contact', response('https://example.com/contact', '<a href="mailto:hello@example.com">Email us</a>')]
  ]);
  const fetchImpl = async url => pages.get(url) || response(url, '', 404);

  const result = await enrichBusinessEmail(
    { name: 'Example Fitness', website: 'https://example.com' },
    { fetchImpl, maxPages: 2 }
  );

  assert.equal(result.status, 'verified');
  assert.equal(result.email, 'hello@example.com');
  assert.equal(result.evidence.sourceUrl, 'https://example.com/contact');
  assert.ok(result.confidence >= 80);
});

test('fails closed when no qualifying public business email is found', async () => {
  const fetchImpl = async url => response(url, '<p>Call us today.</p>');
  const result = await enrichBusinessEmail(
    { name: 'No Email Gym', website: 'https://noemail.example' },
    { fetchImpl, maxPages: 1 }
  );

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'NO_VERIFIED_PUBLIC_BUSINESS_EMAIL');
});

test('batch enrichment reports verified and blocked records', async () => {
  const fetchImpl = async url => {
    if (url.includes('good.example')) return response(url, 'info@good.example');
    return response(url, 'No email here');
  };

  const result = await enrichBatch([
    { name: 'Good', website: 'https://good.example' },
    { name: 'Blocked', website: 'https://blocked.example' }
  ], { fetchImpl, maxPages: 1 });

  assert.equal(result.total, 2);
  assert.equal(result.verified, 1);
  assert.equal(result.blocked, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessage, keyFor } = require('../src/outreach-engine');

test('buildMessage uses configured suggested opener', () => {
  const entry = {
    post: { did: 'did:plc:test', rkey: 'abc', url: 'https://example.com', text: 'Need help scaling' },
    match: { audience: 'business-scaling', score: 80, suggestedOpener: 'Custom opener' }
  };
  assert.equal(buildMessage(entry), 'Custom opener');
});

test('buildMessage falls back to audience-specific copy', () => {
  const entry = {
    post: { did: 'did:plc:test', rkey: 'abc', url: 'https://example.com', text: 'Need help scaling' },
    match: { audience: 'business-scaling', score: 80 }
  };
  assert.match(buildMessage(entry), /LionOS/);
});

test('keyFor produces stable per-post per-audience dedupe key', () => {
  const entry = {
    post: { did: 'did:plc:test', rkey: 'abc' },
    match: { audience: 'business-scaling' }
  };
  assert.equal(keyFor(entry), 'did:plc:test/abc/business-scaling');
});

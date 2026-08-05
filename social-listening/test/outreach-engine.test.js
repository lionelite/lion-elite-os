'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessage, keyFor, isExplicitlyTagged } = require('../src/outreach-engine');

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

test('requires an explicit structured tag of the configured bot DID', () => {
  const tagged = {
    post: { did: 'did:plc:prospect', mentionedDids: ['did:plc:lionbot'] }
  };
  assert.equal(isExplicitlyTagged(tagged, 'did:plc:lionbot'), true);
  assert.equal(isExplicitlyTagged({ post: { did: 'did:plc:prospect', mentionedDids: [] } }, 'did:plc:lionbot'), false);
  assert.equal(isExplicitlyTagged(tagged, ''), false);
});

test('does not treat the bot tagging itself as prospect opt-in', () => {
  const selfPost = {
    post: { did: 'did:plc:lionbot', mentionedDids: ['did:plc:lionbot'] }
  };
  assert.equal(isExplicitlyTagged(selfPost, 'did:plc:lionbot'), false);
});

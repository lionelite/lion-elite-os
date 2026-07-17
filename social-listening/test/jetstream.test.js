'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSubscribeUrl, parseEvent, postUrl, isEnglish } = require('../src/jetstream');

const SAMPLE_COMMIT = JSON.stringify({
  did: 'did:plc:abc123',
  time_us: 1725911162329308,
  kind: 'commit',
  commit: {
    rev: 'aaa',
    operation: 'create',
    collection: 'app.bsky.feed.post',
    rkey: '3l3qo2vutsw2b',
    record: {
      $type: 'app.bsky.feed.post',
      createdAt: '2026-07-17T12:00:00.000Z',
      text: 'hello world',
      langs: ['en']
    },
    cid: 'bafy...'
  }
});

test('builds the subscribe URL with collections and cursor', () => {
  const url = buildSubscribeUrl('jetstream2.us-east.bsky.network', {
    collections: ['app.bsky.feed.post'],
    cursor: 123456789
  });
  assert.equal(
    url,
    'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&cursor=123456789'
  );
});

test('parses a post commit event into a normalized post with URL', () => {
  const post = parseEvent(SAMPLE_COMMIT);
  assert.ok(post);
  assert.equal(post.did, 'did:plc:abc123');
  assert.equal(post.text, 'hello world');
  assert.equal(post.timeUs, 1725911162329308);
  assert.equal(post.isReply, false);
  assert.equal(post.url, 'https://bsky.app/profile/did:plc:abc123/post/3l3qo2vutsw2b');
});

test('ignores deletes, other collections, and malformed payloads', () => {
  const del = JSON.parse(SAMPLE_COMMIT);
  del.commit.operation = 'delete';
  assert.equal(parseEvent(JSON.stringify(del)), null);

  const like = JSON.parse(SAMPLE_COMMIT);
  like.commit.collection = 'app.bsky.feed.like';
  assert.equal(parseEvent(JSON.stringify(like)), null);

  const identity = JSON.stringify({ did: 'did:plc:x', kind: 'identity' });
  assert.equal(parseEvent(identity), null);

  assert.equal(parseEvent('not json'), null);
  assert.equal(parseEvent(JSON.stringify({ kind: 'commit' })), null);

  const noText = JSON.parse(SAMPLE_COMMIT);
  delete noText.commit.record.text;
  assert.equal(parseEvent(JSON.stringify(noText)), null);
});

test('marks reply posts', () => {
  const reply = JSON.parse(SAMPLE_COMMIT);
  reply.commit.record.reply = { parent: { uri: 'at://x' }, root: { uri: 'at://x' } };
  assert.equal(parseEvent(JSON.stringify(reply)).isReply, true);
});

test('language filter accepts en and missing langs, rejects others', () => {
  assert.equal(isEnglish({ langs: ['en'] }), true);
  assert.equal(isEnglish({ langs: [] }), true);
  assert.equal(isEnglish({ langs: ['ja'] }), false);
  assert.equal(isEnglish({ langs: ['pt', 'en'] }), true);
});

test('postUrl builds a bsky.app link', () => {
  assert.equal(postUrl('did:plc:z', 'rk1'), 'https://bsky.app/profile/did:plc:z/post/rk1');
});

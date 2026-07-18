'use strict';

// Minimal Jetstream (Bluesky firehose) client using the built-in WebSocket
// (Node 22+ / bun) — no dependencies.
//
// Jetstream is Bluesky's JSON firehose. Public instances:
//   jetstream1.us-east.bsky.network   jetstream2.us-east.bsky.network
//   jetstream1.us-west.bsky.network   jetstream2.us-west.bsky.network
// Subscribe endpoint: wss://<host>/subscribe with query params:
//   wantedCollections (repeatable), wantedDids (repeatable),
//   cursor (unix microseconds, for replay/resume)
// Commit events look like:
//   { "did": "did:plc:...", "time_us": 1725911162329308, "kind": "commit",
//     "commit": { "rev": "...", "operation": "create",
//                 "collection": "app.bsky.feed.post", "rkey": "...",
//                 "record": { "$type": "app.bsky.feed.post",
//                             "createdAt": "...", "text": "...",
//                             "langs": ["en"], ... }, "cid": "..." } }
// (Documented in github.com/bluesky-social/jetstream. If the shape ever
// changes, parseEvent returns null and the monitor counts it as skipped
// rather than crashing.)

const { EventEmitter } = require('events');

const DEFAULT_HOSTS = [
  'jetstream2.us-east.bsky.network',
  'jetstream1.us-east.bsky.network',
  'jetstream2.us-west.bsky.network',
  'jetstream1.us-west.bsky.network'
];

const POST_COLLECTION = 'app.bsky.feed.post';

function buildSubscribeUrl(host, { collections = [POST_COLLECTION], cursor } = {}) {
  const params = new URLSearchParams();
  for (const collection of collections) params.append('wantedCollections', collection);
  if (cursor) params.set('cursor', String(cursor));
  return `wss://${host}/subscribe?${params.toString()}`;
}

function postUrl(did, rkey) {
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

/**
 * Parse one raw Jetstream message. Returns a normalized post for new
 * app.bsky.feed.post creations, or null for anything else (deletes,
 * likes, identity events, unparseable payloads).
 */
function parseEvent(raw) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!event || event.kind !== 'commit') return null;
  const commit = event.commit;
  if (!commit || commit.operation !== 'create' || commit.collection !== POST_COLLECTION) {
    return null;
  }
  const record = commit.record;
  if (!record || typeof record.text !== 'string') return null;
  return {
    did: event.did,
    timeUs: event.time_us,
    rkey: commit.rkey,
    cid: commit.cid,
    text: record.text,
    langs: Array.isArray(record.langs) ? record.langs : [],
    createdAt: record.createdAt || null,
    isReply: Boolean(record.reply),
    url: postUrl(event.did, commit.rkey)
  };
}

function isEnglish(post) {
  if (post.langs.length === 0) return true; // many clients omit langs
  return post.langs.includes('en');
}

/**
 * Reconnecting Jetstream listener.
 * Emits: 'post' (parsed post), 'status' (string), 'raw-count' (number).
 */
class JetstreamListener extends EventEmitter {
  constructor({ hosts = DEFAULT_HOSTS, collections = [POST_COLLECTION], cursor = null } = {}) {
    super();
    if (typeof WebSocket === 'undefined') {
      throw new Error('Global WebSocket is required (Node 22+ or bun).');
    }
    this.hosts = hosts;
    this.collections = collections;
    this.cursor = cursor;
    this.hostIndex = 0;
    this.backoffMs = 1000;
    this.stopped = false;
    this.ws = null;
    this.eventCount = 0;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const host = this.hosts[this.hostIndex % this.hosts.length];
    const url = buildSubscribeUrl(host, { collections: this.collections, cursor: this.cursor });
    this.emit('status', `connecting to ${host}${this.cursor ? ` (cursor ${this.cursor})` : ''}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1000;
      this.emit('status', `connected to ${host}`);
    };
    ws.onmessage = (message) => {
      this.eventCount += 1;
      const post = parseEvent(message.data);
      if (post) {
        // Resume point: replaying from slightly before the last event is
        // safe (duplicates are dropped by consumers keyed on did+rkey).
        this.cursor = post.timeUs;
        this.emit('post', post);
      }
    };
    ws.onerror = () => { /* onclose always follows; reconnect there */ };
    ws.onclose = (close) => {
      if (this.stopped) return;
      this.emit('status', `disconnected (${close.code}); retrying in ${this.backoffMs}ms`);
      this.hostIndex += 1; // rotate hosts on failure
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60000);
    };
  }

  stop() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }
}

module.exports = {
  DEFAULT_HOSTS,
  POST_COLLECTION,
  buildSubscribeUrl,
  parseEvent,
  postUrl,
  isEnglish,
  JetstreamListener
};

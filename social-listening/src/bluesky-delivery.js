'use strict';

const DEFAULT_SERVICE = 'https://bsky.social';
const PUBLIC_API = 'https://public.api.bsky.app';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for direct Bluesky delivery`);
  return value;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body || {});
    throw new Error(`Bluesky API ${response.status}: ${detail.slice(0, 500)}`);
  }
  return body;
}

async function createSession() {
  const service = String(process.env.BLUESKY_SERVICE_URL || DEFAULT_SERVICE).replace(/\/$/, '');
  return jsonRequest(`${service}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: required('BLUESKY_HANDLE'),
      password: required('BLUESKY_APP_PASSWORD')
    })
  });
}

async function fetchParentRecord(entry) {
  const params = new URLSearchParams({
    repo: entry.post.did,
    collection: 'app.bsky.feed.post',
    rkey: entry.post.rkey
  });
  return jsonRequest(`${PUBLIC_API}/xrpc/com.atproto.repo.getRecord?${params}`);
}

function buildReplyRefs(entry, parentRecord) {
  const parent = {
    uri: `at://${entry.post.did}/app.bsky.feed.post/${entry.post.rkey}`,
    cid: parentRecord.cid
  };
  const root = parentRecord.value?.reply?.root || parent;
  return { parent, root };
}

async function sendReply(entry, message) {
  const session = await createSession();
  const service = String(process.env.BLUESKY_SERVICE_URL || DEFAULT_SERVICE).replace(/\/$/, '');
  const parentRecord = await fetchParentRecord(entry);
  const reply = buildReplyRefs(entry, parentRecord);

  const created = await jsonRequest(`${service}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessJwt}`
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: String(message).slice(0, 300),
        createdAt: new Date().toISOString(),
        reply
      }
    })
  });

  return {
    ok: true,
    mode: 'bluesky-direct',
    uri: created.uri,
    cid: created.cid
  };
}

module.exports = { sendReply, buildReplyRefs };

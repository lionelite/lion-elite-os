'use strict';

const express = require('express');

const app = express();
const port = process.env.PORT || process.env.OUTREACH_WEBHOOK_PORT || 3100;

app.use(express.json({ limit: '256kb' }));

function requireBearer(req, res, next) {
  const expected = process.env.OUTREACH_WEBHOOK_TOKEN;
  if (!expected) return res.status(503).json({ error: 'OUTREACH_WEBHOOK_TOKEN is not configured' });
  const auth = req.get('authorization') || '';
  if (auth !== `Bearer ${expected}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function blueskySession() {
  const identifier = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) throw new Error('BLUESKY_HANDLE and BLUESKY_APP_PASSWORD are required');

  const response = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Bluesky login failed (${response.status}): ${data.message || 'unknown error'}`);
  return data;
}

async function getPostRecord({ did, rkey }, accessJwt) {
  const url = new URL('https://bsky.social/xrpc/com.atproto.repo.getRecord');
  url.searchParams.set('repo', did);
  url.searchParams.set('collection', 'app.bsky.feed.post');
  url.searchParams.set('rkey', rkey);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessJwt}` },
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Could not load source Bluesky post (${response.status}): ${data.message || 'unknown error'}`);
  return data;
}

async function sendReply(payload) {
  const { prospect, message } = payload || {};
  if (!prospect?.did || !prospect?.rkey) throw new Error('prospect.did and prospect.rkey are required');
  if (!message || typeof message !== 'string') throw new Error('message is required');
  if (message.length > 300) throw new Error('message exceeds Bluesky 300-character limit');

  const session = await blueskySession();
  const source = await getPostRecord(prospect, session.accessJwt);
  const sourceUri = source.uri;
  const sourceCid = source.cid;
  const parentReply = source.value?.reply;
  const root = parentReply?.root || { uri: sourceUri, cid: sourceCid };
  const parent = { uri: sourceUri, cid: sourceCid };

  const response = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: message,
        createdAt: new Date().toISOString(),
        reply: { root, parent }
      }
    }),
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Bluesky reply failed (${response.status}): ${data.message || 'unknown error'}`);
  return data;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'lionos-outreach-webhook',
    blueskyConfigured: Boolean(process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD),
    authConfigured: Boolean(process.env.OUTREACH_WEBHOOK_TOKEN),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/outreach', requireBearer, async (req, res) => {
  try {
    if (req.body?.source !== 'bluesky-listener') {
      return res.status(400).json({ error: 'Unsupported source' });
    }
    if (req.body?.action !== 'outreach') {
      return res.status(400).json({ error: 'Unsupported action' });
    }

    const result = await sendReply(req.body);
    res.status(200).json({ ok: true, delivered: true, uri: result.uri, cid: result.cid });
  } catch (error) {
    console.error(`[outreach-webhook] ${error.stack || error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(port, () => {
  console.log(`[outreach-webhook] listening on port ${port}`);
});

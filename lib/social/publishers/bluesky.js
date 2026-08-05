'use strict';

// Bluesky publisher: posts generated brand content to OUR OWN account via
// an app password. Deliberately post-only and completely separate from
// social-listening/ (which stays read-only): this module cannot reply,
// like, follow, DM, or reference any surfaced post — it accepts only a
// text string for our own feed.

const SERVICE = 'https://bsky.social';
const BSKY_GRAPHEME_LIMIT = 300;

async function createSession({ identifier, appPassword }) {
  const response = await fetch(`${SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: appPassword })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.message || `Bluesky auth HTTP ${response.status}`), { code: 'BSKY_AUTH_FAILED' });
  }
  return { accessJwt: data.accessJwt, did: data.did };
}

async function publishPost({ identifier, appPassword, text }) {
  const trimmed = String(text || '').slice(0, BSKY_GRAPHEME_LIMIT);
  const session = await createSession({ identifier, appPassword });
  const response = await fetch(`${SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.accessJwt}`
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: trimmed,
        createdAt: new Date().toISOString(),
        langs: ['en']
      }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.message || `Bluesky post HTTP ${response.status}`), { code: 'BSKY_PUBLISH_FAILED' });
  }
  return { id: data.uri, platform: 'bluesky' };
}

module.exports = { publishPost, createSession, BSKY_GRAPHEME_LIMIT };

'use strict';

// Meta Graph API publisher: Instagram Business (container → publish) and
// Facebook Page posts, for OUR OWN brand accounts only (Issue #48 Phase 2).
// No engagement surface: this module can create posts and nothing else.

const GRAPH = 'https://graph.facebook.com/v21.0';
const CONTAINER_POLL_MS = 3000;
const CONTAINER_POLL_TRIES = 20;

async function graphRequest(path, params, accessToken) {
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const response = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data.error && data.error.message) || `Graph API HTTP ${response.status}`;
    throw Object.assign(new Error(message), { code: 'META_PUBLISH_FAILED', status: response.status });
  }
  return data;
}

async function pollContainer(creationId, accessToken) {
  for (let attempt = 0; attempt < CONTAINER_POLL_TRIES; attempt += 1) {
    const response = await fetch(
      `${GRAPH}/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const data = await response.json().catch(() => ({}));
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') {
      throw Object.assign(new Error('Instagram media container failed processing.'), { code: 'META_CONTAINER_ERROR' });
    }
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_MS));
  }
  throw Object.assign(new Error('Instagram media container timed out.'), { code: 'META_CONTAINER_TIMEOUT' });
}

/**
 * Publish a single image post to an Instagram Business account.
 * Requires a PUBLIC https image URL (the media-hosting layer provides it).
 */
async function publishInstagram({ igUserId, accessToken, imageUrl, caption }) {
  if (!imageUrl) {
    throw Object.assign(new Error('Instagram requires an image URL.'), { code: 'IG_IMAGE_REQUIRED' });
  }
  const container = await graphRequest(`/${igUserId}/media`, { image_url: imageUrl, caption }, accessToken);
  await pollContainer(container.id, accessToken);
  const published = await graphRequest(`/${igUserId}/media_publish`, { creation_id: container.id }, accessToken);
  return { id: published.id, platform: 'instagram' };
}

/** Publish to a Facebook Page: photo post when an image exists, text otherwise. */
async function publishFacebookPage({ pageId, accessToken, message, imageUrl }) {
  const result = imageUrl
    ? await graphRequest(`/${pageId}/photos`, { url: imageUrl, caption: message }, accessToken)
    : await graphRequest(`/${pageId}/feed`, { message }, accessToken);
  return { id: result.post_id || result.id, platform: 'facebook' };
}

module.exports = { publishInstagram, publishFacebookPage };

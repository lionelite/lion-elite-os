'use strict';

// Public media hosting for generated social posts (Issue #48 follow-up).
//
// The repo is public, so the unprotected automation/social-content branch
// doubles as the media store: image files committed under
// content/media/YYYY-MM-DD/<piece-id>.png are served as stable HTTPS URLs
// via raw.githubusercontent.com — no extra storage service, no secrets.
// Those URLs go into the Metricool CSV's "Picture Url 1" column, so posts
// import with their media attached.
//
// Where the image files come from, in priority order:
//  1. Already on disk (a human dropped a finished image into
//     content/media/<date>/ on the automation branch — always wins).
//  2. Optional AI generation (AI_IMAGE_ENABLED=true + AI_API_KEY /
//     OPENAI_API_KEY) from the piece's media prompt. Off by default so no
//     one is surprised by per-image API charges.
//  3. Neither → the CSV row simply has no picture URL, same as before.

const DEFAULT_REPO = 'lionelite/lion-elite-os';
const DEFAULT_BRANCH = 'automation/social-content';
const DEFAULT_IMAGE_MODEL = 'gpt-image-1';
const IMAGE_TIMEOUT_MS = 120000;

function mediaRelativePath(piece) {
  return `content/media/${piece.date}/${piece.id}.png`;
}

/**
 * Stable HTTPS URL for a piece's image once it is committed to the
 * automation branch. MEDIA_BASE_URL overrides everything (e.g. a future
 * CDN/site host); it is joined with the same relative path.
 */
function mediaUrlFor(piece, env = process.env) {
  const base = (env.MEDIA_BASE_URL || '').trim().replace(/\/$/, '');
  if (base) return `${base}/${mediaRelativePath(piece)}`;
  const repo = (env.GITHUB_REPOSITORY || DEFAULT_REPO).trim();
  const branch = (env.MEDIA_BRANCH || DEFAULT_BRANCH).trim();
  return `https://raw.githubusercontent.com/${repo}/${branch}/${mediaRelativePath(piece)}`;
}

function resolveImageConfig(env = process.env) {
  const apiKey = (env.AI_API_KEY || env.OPENAI_API_KEY || '').trim();
  return {
    enabled: String(env.AI_IMAGE_ENABLED).toLowerCase() === 'true' && apiKey.length > 0,
    apiKey,
    model: (env.AI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim()
  };
}

// gpt-image-1 supports 1024x1024, 1024x1536 (portrait), 1536x1024. Both
// target formats (1080x1350 feed, 1080x1920 story/reel) map to portrait —
// closest available aspect; Metricool/platforms handle the crop.
function imageSizeFor() {
  return '1024x1536';
}

/**
 * Generate one image from the piece's media prompt. Returns a PNG Buffer,
 * or null on any failure (missing key, HTTP error, timeout) — callers
 * fall back to no-image rather than failing the daily run.
 */
async function generateImage({ prompt, config = resolveImageConfig() }) {
  if (!config.enabled) return null;
  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        prompt,
        n: 1,
        size: imageSizeFor(),
        quality: 'medium'
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (typeof b64 !== 'string' || b64.length === 0) return null;
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULT_BRANCH,
  mediaRelativePath,
  mediaUrlFor,
  resolveImageConfig,
  imageSizeFor,
  generateImage
};

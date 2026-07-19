'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mediaRelativePath, mediaUrlFor, resolveImageConfig, generateImage, imageSizeFor } = require('../lib/social/media-hosting');
const { generateDailyPlan } = require('../lib/social/content-generator');
const { pieceToRows } = require('../lib/social/metricool-csv');

const PIECE = { id: '2026-07-20-wellness-feed', date: '2026-07-20', slot: 'feed' };

test('media path and default raw.githubusercontent URL are stable and branch-pinned', () => {
  assert.equal(mediaRelativePath(PIECE), 'content/media/2026-07-20/2026-07-20-wellness-feed.png');
  assert.equal(
    mediaUrlFor(PIECE, {}),
    'https://raw.githubusercontent.com/lionelite/lion-elite-os/automation/social-content/content/media/2026-07-20/2026-07-20-wellness-feed.png'
  );
  assert.equal(
    mediaUrlFor(PIECE, { GITHUB_REPOSITORY: 'lionelite/lion-elite-os', MEDIA_BRANCH: 'other-branch' }),
    'https://raw.githubusercontent.com/lionelite/lion-elite-os/other-branch/content/media/2026-07-20/2026-07-20-wellness-feed.png'
  );
});

test('MEDIA_BASE_URL overrides the host for a future CDN/site move', () => {
  assert.equal(
    mediaUrlFor(PIECE, { MEDIA_BASE_URL: 'https://media.lionelitewellness.com/' }),
    'https://media.lionelitewellness.com/content/media/2026-07-20/2026-07-20-wellness-feed.png'
  );
});

test('AI image generation is off unless explicitly enabled AND a key exists', () => {
  assert.equal(resolveImageConfig({}).enabled, false);
  assert.equal(resolveImageConfig({ AI_IMAGE_ENABLED: 'true' }).enabled, false);
  assert.equal(resolveImageConfig({ AI_API_KEY: 'k' }).enabled, false);
  assert.equal(resolveImageConfig({ AI_IMAGE_ENABLED: 'true', AI_API_KEY: 'k' }).enabled, true);
  assert.equal(resolveImageConfig({ AI_IMAGE_ENABLED: 'true', OPENAI_API_KEY: 'k' }).enabled, true);
});

test('generateImage returns null when disabled (no network call, no throw)', async () => {
  assert.equal(await generateImage({ prompt: 'x', config: { enabled: false } }), null);
});

test('image size maps to the portrait format gpt-image-1 supports', () => {
  assert.equal(imageSizeFor(), '1024x1536');
});

test('hosted media URL lands in the Metricool Picture Url 1 column', () => {
  const plan = generateDailyPlan({ brand: 'wellness', date: '2026-07-20' });
  const feed = plan.pieces.find((p) => p.slot === 'feed');

  // No image file → empty column, exactly as before.
  for (const row of pieceToRows(feed)) assert.equal(row['Picture Url 1'], '');

  feed.media.url = mediaUrlFor(feed, {});
  for (const row of pieceToRows(feed)) {
    assert.equal(row['Picture Url 1'], feed.media.url);
    assert.match(row['Picture Url 1'], /^https:\/\/raw\.githubusercontent\.com\//);
  }
});

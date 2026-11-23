'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVideoUrl,
  timestampedUrl,
  formatTimestamp,
  parseStartSeconds
} = require('../lib/video-learning/video-sources');

test('parses every common YouTube link shape onto one canonical source', () => {
  const variants = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abcd1234',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'youtube.com/watch?v=dQw4w9WgXcQ',
    '<https://youtu.be/dQw4w9WgXcQ>'
  ];
  for (const variant of variants) {
    const source = parseVideoUrl(variant);
    assert.ok(source, `expected ${variant} to parse`);
    assert.equal(source.platform, 'youtube');
    assert.equal(source.videoId, 'dQw4w9WgXcQ');
    assert.equal(source.canonicalUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(source.sourceKey, 'youtube-dQw4w9WgXcQ');
  }
});

test('tags shorts and live links with their kind', () => {
  assert.equal(parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ').kind, 'short');
  assert.equal(parseVideoUrl('https://www.youtube.com/live/dQw4w9WgXcQ').kind, 'live');
  assert.equal(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ').kind, 'video');
});

test('reads a start offset from both seconds and duration forms', () => {
  assert.equal(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=90').startSeconds, 90);
  assert.equal(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=1m30s').startSeconds, 90);
  assert.equal(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s').startSeconds, 3723);
  assert.equal(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ').startSeconds, null);
  assert.equal(parseStartSeconds('not-a-time'), null);
});

test('parses Instagram reels, posts, and profile-prefixed links', () => {
  const reel = parseVideoUrl('https://www.instagram.com/reel/Cx1yZ_abcDE/');
  assert.equal(reel.platform, 'instagram');
  assert.equal(reel.kind, 'reel');
  assert.equal(reel.canonicalUrl, 'https://www.instagram.com/reel/Cx1yZ_abcDE/');
  assert.equal(reel.sourceKey, 'instagram-Cx1yZ_abcDE');

  assert.equal(parseVideoUrl('https://instagram.com/p/Cx1yZ_abcDE/').kind, 'post');
  assert.equal(parseVideoUrl('https://www.instagram.com/tv/Cx1yZ_abcDE/').kind, 'igtv');

  // Shared links often carry the creator's handle and a tracking parameter.
  const shared = parseVideoUrl('https://www.instagram.com/lionelite/reel/Cx1yZ_abcDE/?igsh=xyz');
  assert.equal(shared.sourceKey, 'instagram-Cx1yZ_abcDE');
});

test('rejects links that are not a single supported video', () => {
  const rejected = [
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.instagram.com/lionelite/',
    'https://vimeo.com/123456789',
    'https://example.com/video.mp4',
    'javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ',
    '',
    null,
    undefined
  ];
  for (const value of rejected) {
    assert.equal(parseVideoUrl(value), null, `expected ${String(value)} to be rejected`);
  }
});

test('builds timestamped citation links for YouTube and falls back for Instagram', () => {
  const youtube = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(timestampedUrl(youtube, 125.7), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=125');
  assert.equal(timestampedUrl(youtube, null), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  const instagram = parseVideoUrl('https://www.instagram.com/reel/Cx1yZ_abcDE/');
  assert.equal(timestampedUrl(instagram, 42), 'https://www.instagram.com/reel/Cx1yZ_abcDE/');
});

test('formats timestamps the way a viewer reads them', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(75), '1:15');
  assert.equal(formatTimestamp(3725), '1:02:05');
  assert.equal(formatTimestamp(null), null);
  assert.equal(formatTimestamp(-5), null);
});

'use strict';

// URL parsing for the video learning connection.
//
// Pure functions only — no network, no filesystem — so the whole surface is
// unit-testable the same way lib/integration-normalization.js is. Everything
// downstream (transcript fetching, lesson storage, dedupe) keys off the
// `sourceKey` produced here, so parsing has to be the one place that decides
// what "the same video" means.

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be'
]);

const INSTAGRAM_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am',
  'ddinstagram.com'
]);

// YouTube video ids are always exactly 11 url-safe base64 characters.
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
// Instagram shortcodes are url-safe base64 and vary in length.
const INSTAGRAM_SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{5,32}$/;

// Path segments that introduce an Instagram media shortcode. Instagram serves
// the same media under several of these, and profile-prefixed variants
// (/<user>/reel/<code>/) are common in shared links.
const INSTAGRAM_MEDIA_SEGMENTS = new Map([
  ['reel', 'reel'],
  ['reels', 'reel'],
  ['p', 'post'],
  ['tv', 'igtv']
]);

/**
 * Coerce owner-pasted text into something the URL parser can accept.
 * Handles bare domains, protocol-relative links, and the angle brackets
 * that chat clients wrap around pasted links.
 */
function normalizeInput(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (!value) return '';
  // Markdown autolinks and mail clients: <https://...>
  value = value.replace(/^<+/, '').replace(/>+$/, '');
  // Trailing punctuation from prose ("watch this: youtu.be/abc.")
  value = value.replace(/[.,;)\]]+$/, '');
  if (!value) return '';
  if (/^\/\//.test(value)) return `https:${value}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return `https://${value}`;
  return value;
}

function toUrl(raw) {
  const normalized = normalizeInput(raw);
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function pathSegments(url) {
  return url.pathname.split('/').filter(Boolean);
}

/**
 * Read a start offset out of a YouTube `t`/`start` parameter.
 * Accepts raw seconds ("90") and the duration form ("1m30s", "1h2m3s").
 */
function parseStartSeconds(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim().toLowerCase();
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || !match.slice(1).some(Boolean)) return null;
  const [hours, minutes, seconds] = match.slice(1).map((part) => Number(part || 0));
  return hours * 3600 + minutes * 60 + seconds;
}

function parseYouTube(url) {
  const segments = pathSegments(url);
  let videoId = null;
  let kind = 'video';

  if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') {
    videoId = segments[0] || null;
  } else if (segments[0] === 'watch') {
    videoId = url.searchParams.get('v');
  } else if (segments.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(segments[0])) {
    videoId = segments[1];
    if (segments[0] === 'shorts') kind = 'short';
    if (segments[0] === 'live') kind = 'live';
  }

  if (!videoId || !YOUTUBE_ID_PATTERN.test(videoId)) return null;

  const startSeconds =
    parseStartSeconds(url.searchParams.get('t')) ??
    parseStartSeconds(url.searchParams.get('start'));

  return {
    platform: 'youtube',
    videoId,
    kind,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    sourceKey: `youtube-${videoId}`,
    startSeconds
  };
}

function parseInstagram(url) {
  const segments = pathSegments(url);
  // Scan rather than index so both /reel/<code>/ and /<user>/reel/<code>/ work.
  for (let i = 0; i < segments.length - 1; i += 1) {
    const kind = INSTAGRAM_MEDIA_SEGMENTS.get(segments[i].toLowerCase());
    if (!kind) continue;
    const shortcode = segments[i + 1];
    if (!INSTAGRAM_SHORTCODE_PATTERN.test(shortcode)) return null;
    // Instagram canonicalizes every reel variant onto /reel/<code>/.
    const canonicalSegment = kind === 'reel' ? 'reel' : kind === 'igtv' ? 'tv' : 'p';
    return {
      platform: 'instagram',
      videoId: shortcode,
      kind,
      canonicalUrl: `https://www.instagram.com/${canonicalSegment}/${shortcode}/`,
      sourceKey: `instagram-${shortcode}`,
      startSeconds: null
    };
  }
  return null;
}

/**
 * Parse a YouTube or Instagram URL into a canonical video source.
 *
 * @param {string} raw - a URL, bare domain, or pasted link
 * @returns {null|{platform: string, videoId: string, kind: string,
 *   canonicalUrl: string, sourceKey: string, startSeconds: number|null}}
 *   null when the input is not a supported single-video link.
 */
function parseVideoUrl(raw) {
  const url = toUrl(raw);
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return parseYouTube(url);
  if (INSTAGRAM_HOSTS.has(host)) return parseInstagram(url);
  return null;
}

/**
 * Build a link back into the source video at a specific offset, so every
 * extracted lesson line stays checkable against what was actually said.
 * Instagram has no timestamp deep-link, so it returns the canonical URL.
 */
function timestampedUrl(source, seconds) {
  if (!source || !source.canonicalUrl) return null;
  const offset = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : null;
  if (offset === null || source.platform !== 'youtube') return source.canonicalUrl;
  return `${source.canonicalUrl}&t=${offset}`;
}

/** Format seconds as h:mm:ss / m:ss for human-readable lesson output. */
function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

module.exports = {
  parseVideoUrl,
  timestampedUrl,
  formatTimestamp,
  parseStartSeconds,
  normalizeInput
};

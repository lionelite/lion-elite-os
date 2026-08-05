'use strict';

// Auto-publish orchestrator (Issue #48 Phase 2, owner-authorized
// 2026-07-19): posts the day's compliance-validated generated content to
// OUR OWN brand accounts on the platforms that have credentials
// configured. Fail-closed and idempotent:
//  - publishes nothing unless SOCIAL_PUBLISH_ENABLED=true
//  - a platform with missing credentials is skipped, never errored
//  - only pieces that passed compliance validation exist in
//    social-content.json, so only validated content can ever publish
//  - the publish log is consulted first — a workflow rerun cannot
//    double-post a piece that already succeeded
//
// Publishing surface per brand per day (Phase 2 "lite"):
//  - feed piece → Instagram (needs hosted image), Facebook Page, X, Bluesky
//  - reel piece / stories → NOT auto-published (video/story APIs need
//    TikTok/LinkedIn app approvals or video assets we don't generate)

const { publishInstagram, publishFacebookPage } = require('./publishers/meta');
const { publishTweet } = require('./publishers/x');
const { publishPost: publishBluesky } = require('./publishers/bluesky');

const BRAND_ENV_PREFIX = { wellness: 'WELLNESS', beauty: 'BEAUTY' };

function isPublishingEnabled(env = process.env) {
  return String(env.SOCIAL_PUBLISH_ENABLED).toLowerCase() === 'true';
}

/** Resolve per-brand platform credentials from env. Missing vars disable a platform. */
function resolveBrandTargets(brand, env = process.env) {
  const prefix = BRAND_ENV_PREFIX[brand];
  if (!prefix) return {};
  const value = (name) => (env[`${prefix}_${name}`] || '').trim();
  const targets = {};

  if (value('IG_USER_ID') && value('META_ACCESS_TOKEN')) {
    targets.instagram = { igUserId: value('IG_USER_ID'), accessToken: value('META_ACCESS_TOKEN') };
  }
  if (value('META_PAGE_ID') && value('META_ACCESS_TOKEN')) {
    targets.facebook = { pageId: value('META_PAGE_ID'), accessToken: value('META_ACCESS_TOKEN') };
  }
  if (value('X_API_KEY') && value('X_API_SECRET') && value('X_ACCESS_TOKEN') && value('X_ACCESS_SECRET')) {
    targets.x = {
      credentials: {
        apiKey: value('X_API_KEY'),
        apiSecret: value('X_API_SECRET'),
        accessToken: value('X_ACCESS_TOKEN'),
        accessSecret: value('X_ACCESS_SECRET')
      }
    };
  }
  if (value('BSKY_IDENTIFIER') && value('BSKY_APP_PASSWORD')) {
    targets.bluesky = { identifier: value('BSKY_IDENTIFIER'), appPassword: value('BSKY_APP_PASSWORD') };
  }
  return targets;
}

/** The publishable plan for one day: feed pieces only, per platform rules. */
function selectPublishTargets(payload, env = process.env) {
  const selected = [];
  for (const [brand, data] of Object.entries(payload.brands || {})) {
    const targets = resolveBrandTargets(brand, env);
    const feed = (data.pieces || []).find((piece) => piece.slot === 'feed');
    if (!feed || Object.keys(targets).length === 0) continue;
    // Marketing quality gate: a piece the judge held below threshold is
    // never published (it stays in the JSON, flagged, for human review).
    if (feed.marketing && feed.marketing.approved === false) continue;

    if (targets.instagram && feed.media && feed.media.url && feed.platforms.instagram) {
      selected.push({ brand, piece: feed, platform: 'instagram', target: targets.instagram });
    }
    if (targets.facebook && feed.platforms.facebook) {
      selected.push({ brand, piece: feed, platform: 'facebook', target: targets.facebook });
    }
    if (targets.x && feed.platforms.x) {
      selected.push({ brand, piece: feed, platform: 'x', target: targets.x });
    }
    if (targets.bluesky && feed.platforms.x) {
      // Bluesky reuses the short-form X variant (280 ≤ its 300 limit).
      selected.push({ brand, piece: feed, platform: 'bluesky', target: targets.bluesky });
    }
  }
  return selected;
}

/** Drop targets that already succeeded in a previous run (idempotency). */
function filterAlreadyPublished(targets, publishLog) {
  const succeeded = new Set(
    (publishLog && publishLog.results ? publishLog.results : [])
      .filter((entry) => entry.status === 'published')
      .map((entry) => `${entry.pieceId}:${entry.platform}`)
  );
  return targets.filter((t) => !succeeded.has(`${t.piece.id}:${t.platform}`));
}

async function publishOne({ piece, platform, target }) {
  if (platform === 'instagram') {
    return publishInstagram({
      igUserId: target.igUserId,
      accessToken: target.accessToken,
      imageUrl: piece.media.url,
      caption: piece.platforms.instagram.text
    });
  }
  if (platform === 'facebook') {
    return publishFacebookPage({
      pageId: target.pageId,
      accessToken: target.accessToken,
      message: piece.platforms.facebook.text,
      imageUrl: (piece.media && piece.media.url) || null
    });
  }
  if (platform === 'x') {
    return publishTweet({ credentials: target.credentials, text: piece.platforms.x.text });
  }
  if (platform === 'bluesky') {
    return publishBluesky({
      identifier: target.identifier,
      appPassword: target.appPassword,
      text: piece.platforms.x.text
    });
  }
  throw Object.assign(new Error(`Unknown platform: ${platform}`), { code: 'UNKNOWN_PLATFORM' });
}

/**
 * Publish everything publishable for the day. Returns the updated publish
 * log entries; individual failures are recorded, never thrown, so one bad
 * platform can't block the others.
 */
async function publishAll({ payload, publishLog, env = process.env, logger = console.log }) {
  const results = (publishLog && publishLog.results) ? [...publishLog.results] : [];
  if (!isPublishingEnabled(env)) {
    logger('[publish] SOCIAL_PUBLISH_ENABLED is not true — publishing skipped (fail-closed).');
    return { results, published: 0, failed: 0, skipped: true };
  }

  const targets = filterAlreadyPublished(selectPublishTargets(payload, env), publishLog);
  let published = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      const outcome = await publishOne(target);
      results.push({
        pieceId: target.piece.id,
        brand: target.brand,
        platform: target.platform,
        status: 'published',
        remoteId: outcome.id || null,
        at: new Date().toISOString()
      });
      published += 1;
      logger(`[publish] published  ${target.piece.id} → ${target.platform} (${outcome.id || 'ok'})`);
    } catch (error) {
      results.push({
        pieceId: target.piece.id,
        brand: target.brand,
        platform: target.platform,
        status: 'failed',
        error: `${error.code || 'PUBLISH_FAILED'}: ${error.message}`,
        at: new Date().toISOString()
      });
      failed += 1;
      logger(`[publish] FAILED     ${target.piece.id} → ${target.platform}: ${error.message}`);
    }
  }

  return { results, published, failed, skipped: false };
}

module.exports = {
  isPublishingEnabled,
  resolveBrandTargets,
  selectPublishTargets,
  filterAlreadyPublished,
  publishAll
};

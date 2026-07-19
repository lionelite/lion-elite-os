'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPublishingEnabled, resolveBrandTargets, selectPublishTargets, filterAlreadyPublished, publishAll
} = require('../lib/social/publish-orchestrator');
const { buildOAuth1Header, percentEncode } = require('../lib/social/publishers/x');

function samplePayload() {
  return {
    brands: {
      wellness: {
        pieces: [{
          id: '2026-07-20-wellness-feed',
          slot: 'feed',
          media: { url: 'https://raw.githubusercontent.com/lionelite/lion-elite-os/automation/social-content/content/media/2026-07-20/2026-07-20-wellness-feed.png' },
          platforms: {
            instagram: { text: 'IG caption' },
            facebook: { text: 'FB caption' },
            x: { text: 'X caption' }
          }
        }, {
          id: '2026-07-20-wellness-reel', slot: 'reel', platforms: { tiktok: { text: 'script' } }
        }]
      }
    }
  };
}

const FULL_ENV = {
  SOCIAL_PUBLISH_ENABLED: 'true',
  WELLNESS_IG_USER_ID: 'ig1', WELLNESS_META_ACCESS_TOKEN: 'tok', WELLNESS_META_PAGE_ID: 'pg1',
  WELLNESS_X_API_KEY: 'k', WELLNESS_X_API_SECRET: 's', WELLNESS_X_ACCESS_TOKEN: 'at', WELLNESS_X_ACCESS_SECRET: 'as',
  WELLNESS_BSKY_IDENTIFIER: 'lew.bsky.social', WELLNESS_BSKY_APP_PASSWORD: 'app-pass'
};

test('publishing is fail-closed unless SOCIAL_PUBLISH_ENABLED=true', () => {
  assert.equal(isPublishingEnabled({}), false);
  assert.equal(isPublishingEnabled({ SOCIAL_PUBLISH_ENABLED: 'false' }), false);
  assert.equal(isPublishingEnabled({ SOCIAL_PUBLISH_ENABLED: 'true' }), true);
});

test('a platform with missing credentials is simply not a target', () => {
  // IG token present but no Page id → IG yes, FB no.
  const igOnly = resolveBrandTargets('wellness', { WELLNESS_IG_USER_ID: 'ig1', WELLNESS_META_ACCESS_TOKEN: 'tok' });
  assert.ok(igOnly.instagram);
  assert.equal(igOnly.facebook, undefined);
  assert.equal(igOnly.x, undefined);
  assert.equal(igOnly.bluesky, undefined);
  // Add the Page id → FB becomes a target, sharing the access token.
  const withPage = resolveBrandTargets('wellness', { WELLNESS_META_PAGE_ID: 'pg1', WELLNESS_META_ACCESS_TOKEN: 'tok' });
  assert.ok(withPage.facebook);
});

test('only the feed piece is publishable; reel/stories are not auto-published', () => {
  const targets = selectPublishTargets(samplePayload(), FULL_ENV);
  const pieceIds = new Set(targets.map((t) => t.piece.id));
  assert.ok(pieceIds.has('2026-07-20-wellness-feed'));
  assert.equal(pieceIds.has('2026-07-20-wellness-reel'), false);
  assert.deepEqual(new Set(targets.map((t) => t.platform)), new Set(['instagram', 'facebook', 'x', 'bluesky']));
});

test('Instagram is skipped when the piece has no hosted image', () => {
  const payload = samplePayload();
  delete payload.brands.wellness.pieces[0].media;
  const targets = selectPublishTargets(payload, FULL_ENV);
  assert.equal(targets.some((t) => t.platform === 'instagram'), false);
  assert.ok(targets.some((t) => t.platform === 'facebook')); // FB can post text-only
});

test('idempotency: a piece/platform that already succeeded is not re-published', () => {
  const targets = selectPublishTargets(samplePayload(), FULL_ENV);
  const publishLog = { results: [{ pieceId: '2026-07-20-wellness-feed', platform: 'x', status: 'published' }] };
  const remaining = filterAlreadyPublished(targets, publishLog);
  assert.equal(remaining.some((t) => t.platform === 'x'), false);
  assert.ok(remaining.some((t) => t.platform === 'instagram'));
  // A previously FAILED attempt is retried.
  const withFail = { results: [{ pieceId: '2026-07-20-wellness-feed', platform: 'x', status: 'failed' }] };
  assert.ok(filterAlreadyPublished(targets, withFail).some((t) => t.platform === 'x'));
});

test('publishAll short-circuits when disabled and posts nothing', async () => {
  const result = await publishAll({ payload: samplePayload(), publishLog: { results: [] }, env: {}, logger: () => {} });
  assert.equal(result.skipped, true);
  assert.equal(result.published, 0);
});

test('publishAll records per-platform failures without throwing', async () => {
  // No network in tests: every real publish call rejects, which must be
  // captured as a failed result, not propagated.
  const result = await publishAll({
    payload: samplePayload(),
    publishLog: { results: [] },
    env: { SOCIAL_PUBLISH_ENABLED: 'true', WELLNESS_BSKY_IDENTIFIER: 'x.bsky.social', WELLNESS_BSKY_APP_PASSWORD: 'p' },
    logger: () => {}
  });
  assert.equal(result.published, 0);
  assert.ok(result.failed >= 1);
  assert.ok(result.results.every((r) => r.status === 'failed'));
});

test('OAuth1 header is deterministic for fixed nonce/timestamp', () => {
  const header = buildOAuth1Header({
    method: 'POST',
    url: 'https://api.twitter.com/2/tweets',
    credentials: { apiKey: 'ck', apiSecret: 'cs', accessToken: 'at', accessSecret: 'ats' },
    nonce: 'fixednonce',
    timestamp: 1700000000
  });
  assert.match(header, /^OAuth /);
  assert.match(header, /oauth_signature="[^"]+"/);
  assert.match(header, /oauth_consumer_key="ck"/);
  assert.equal(percentEncode('a b!'), 'a%20b%21');
});

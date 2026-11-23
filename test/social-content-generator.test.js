'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDailyPlan, X_CHAR_LIMIT } = require('../lib/social/content-generator');
const { validatePiece } = require('../lib/social/social-compliance');
const { BRAND_KEYS, getBrandProfile, WELLNESS_DISCLAIMER } = require('../lib/social/brand-profiles');

const DATE = '2026-07-17';

test('produces the required daily cadence for each brand: 1 feed, 1 reel, 2 stories', () => {
  for (const brand of BRAND_KEYS) {
    const plan = generateDailyPlan({ brand, date: DATE });
    const slots = plan.pieces.map((p) => p.slot);
    assert.deepEqual(slots, ['feed', 'reel', 'story-1', 'story-2'], brand);
  }
});

test('every template piece passes compliance validation for its brand', () => {
  for (const brand of BRAND_KEYS) {
    const profile = getBrandProfile(brand);
    const plan = generateDailyPlan({ brand, date: DATE });
    for (const piece of plan.pieces) {
      const result = validatePiece(piece, profile);
      assert.equal(
        result.approved,
        true,
        `${piece.id} blocked: ${JSON.stringify(result.platforms)}`
      );
    }
  }
});

test('wellness content always carries the research disclaimer', () => {
  const plan = generateDailyPlan({ brand: 'wellness', date: DATE });
  for (const piece of plan.pieces) {
    for (const [platform, variant] of Object.entries(piece.platforms)) {
      assert.ok(
        variant.text.includes(WELLNESS_DISCLAIMER),
        `${piece.id} ${platform} missing disclaimer`
      );
    }
  }
});

test('feed and reel use distinct topics; stories support the feed topic', () => {
  const plan = generateDailyPlan({ brand: 'beauty', date: DATE });
  const [feed, reel, story1, story2] = plan.pieces;
  assert.notEqual(feed.topic.slug, reel.topic.slug);
  assert.equal(story1.topic.slug, feed.topic.slug);
  assert.equal(story2.topic.slug, feed.topic.slug);
});

test('platform variants are distinct across brands and platforms', () => {
  const texts = new Set();
  let total = 0;
  for (const brand of BRAND_KEYS) {
    const plan = generateDailyPlan({ brand, date: DATE });
    for (const piece of plan.pieces) {
      for (const variant of Object.values(piece.platforms)) {
        texts.add(variant.text);
        total += 1;
      }
    }
  }
  assert.equal(texts.size, total);
});

test('X posts stay within the character limit for every topic in both pools', () => {
  for (const brand of BRAND_KEYS) {
    const profile = getBrandProfile(brand);
    for (let day = 0; day < profile.topics.length; day += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
      const plan = generateDailyPlan({ brand, date });
      const feed = plan.pieces.find((p) => p.slot === 'feed');
      assert.ok(
        feed.platforms.x.text.length <= X_CHAR_LIMIT,
        `${brand} ${date}: ${feed.platforms.x.text.length} chars`
      );
    }
  }
});

test('media specs match Issue #48 dimensions: 1080x1350 feed, 1080x1920 stories/reels', () => {
  const plan = generateDailyPlan({ brand: 'wellness', date: DATE });
  const bySlot = Object.fromEntries(plan.pieces.map((p) => [p.slot, p.media]));
  assert.equal(bySlot.feed.dimensions, '1080x1350');
  assert.equal(bySlot.reel.dimensions, '1080x1920');
  assert.equal(bySlot['story-1'].dimensions, '1080x1920');
  assert.equal(bySlot['story-2'].dimensions, '1080x1920');
  for (const media of Object.values(bySlot)) {
    assert.ok(media.prompt.length > 40, 'media prompt should be descriptive');
  }
});

test('CTAs rotate day over day within each brand rotation set', () => {
  const profile = getBrandProfile('wellness');
  const seen = new Set();
  for (let day = 0; day < profile.ctaRotation.length; day += 1) {
    const date = new Date(Date.UTC(2026, 2, 1 + day)).toISOString().slice(0, 10);
    const plan = generateDailyPlan({ brand: 'wellness', date });
    seen.add(plan.pieces.find((p) => p.slot === 'feed').cta);
  }
  assert.equal(seen.size, profile.ctaRotation.length);
});

test('rejects an invalid date instead of generating misdated content', () => {
  assert.throws(() => generateDailyPlan({ brand: 'wellness', date: 'not-a-date' }), /Invalid date/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { heuristicScore, qualifyCaption, DEFAULT_THRESHOLD } = require('../lib/social/marketing-judge');
const { selectPublishTargets } = require('../lib/social/publish-orchestrator');

test('threshold default is 9.5 as specified', () => {
  assert.equal(DEFAULT_THRESHOLD, 9.5);
});

test('heuristic score returns a bounded number with all rubric dimensions', () => {
  const result = heuristicScore('Why most research peptides fail QC.\n\nThree things a real COA shows. Explore the catalog at lionelitewellness.com.');
  assert.ok(result.score >= 0 && result.score <= 10);
  for (const dim of ['hook', 'clarity', 'relevance', 'cta', 'conversion', 'brand_voice']) {
    assert.ok(dim in result.dimensions, `missing ${dim}`);
  }
  assert.match(result.feedback, /Weakest dimension/);
});

test('a strong-signal caption scores higher than a weak generic one', () => {
  const strong = heuristicScore('Why nobody checks the batch number.\n\nThe one line on a COA that matters. Explore the catalog — lionelitewellness.com.');
  const weak = heuristicScore('Hello, we are a company that sells things and we are writing a very long sentence that goes on and on without any clear point or call to action whatsoever and never really tells the reader what to do next.');
  assert.ok(strong.score > weak.score, `${strong.score} !> ${weak.score}`);
});

test('qualifyCaption approves when a judge meets the threshold', async () => {
  const result = await qualifyCaption({
    text: 'great copy',
    brand: 'Lion Elite Wellness',
    platform: 'instagram',
    judge: async () => ({ score: 9.7, dimensions: {}, feedback: 'ok', judge: 'stub' })
  });
  assert.equal(result.approved, true);
  assert.equal(result.attempts, 1);
});

test('qualifyCaption regenerates on a miss and adopts an improved rewrite', async () => {
  const scores = [8.0, 9.6];
  let regenCalls = 0;
  const result = await qualifyCaption({
    text: 'v1',
    brand: 'b',
    platform: 'instagram',
    judge: async ({ text }) => ({ score: text === 'v2' ? scores[1] : scores[0], dimensions: {}, feedback: 'sharpen hook', judge: 'stub' }),
    regenerate: async () => { regenCalls += 1; return 'v2'; }
  });
  assert.equal(result.approved, true);
  assert.equal(result.text, 'v2');
  assert.equal(regenCalls, 1);
  assert.equal(result.attempts, 2);
});

test('qualifyCaption never approves below threshold and returns the best attempt', async () => {
  const result = await qualifyCaption({
    text: 'v1',
    brand: 'b',
    platform: 'instagram',
    maxAttempts: 3,
    judge: async ({ text }) => ({ score: text === 'v1' ? 8.0 : 8.5, dimensions: {}, feedback: 'meh', judge: 'stub' }),
    regenerate: async () => 'v2'
  });
  assert.equal(result.approved, false);
  assert.equal(result.score, 8.5); // best seen
  assert.match(result.reason, /< threshold 9\.5/);
});

test('qualifyCaption stops early when regeneration returns null', async () => {
  let judgeCalls = 0;
  const result = await qualifyCaption({
    text: 'v1',
    brand: 'b',
    platform: 'instagram',
    maxAttempts: 5,
    judge: async () => { judgeCalls += 1; return { score: 7, dimensions: {}, feedback: 'x', judge: 'stub' }; },
    regenerate: async () => null // e.g. a compliant rewrite couldn't be produced
  });
  assert.equal(result.approved, false);
  assert.equal(judgeCalls, 1);
});

test('publisher skips a feed piece the marketing gate held below threshold', () => {
  const env = {
    SOCIAL_PUBLISH_ENABLED: 'true',
    WELLNESS_BSKY_IDENTIFIER: 'lew.bsky.social', WELLNESS_BSKY_APP_PASSWORD: 'p'
  };
  const payload = {
    brands: {
      wellness: {
        pieces: [{
          id: '2026-07-20-wellness-feed', slot: 'feed',
          media: { url: 'https://x/y.jpg' },
          platforms: { x: { text: 'X caption' } },
          marketing: { approved: false, score: 8.1, threshold: 9.5 }
        }]
      }
    }
  };
  assert.deepEqual(selectPublishTargets(payload, env), []);

  // Flip to approved → it becomes publishable again.
  payload.brands.wellness.pieces[0].marketing.approved = true;
  assert.ok(selectPublishTargets(payload, env).length >= 1);
});

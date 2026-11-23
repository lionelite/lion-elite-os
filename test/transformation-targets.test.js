'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OUTBOUND_SEGMENTS,
  INBOUND_INTENT_THEMES,
  SELF_DECLARED_ONLY,
  acquisitionCatalog,
  transformationCampaignSeeds
} = require('../lib/platform/transformation-targets');
const { buildCapture, LANES } = require('../lib/leads/consent-capture');

test('transformation targeting catalog exposes outbound and inbound markets', () => {
  const catalog = acquisitionCatalog();
  assert.equal(catalog.product, 'Life Transformation / Life Audit');
  assert.equal(catalog.outboundSegments.length, OUTBOUND_SEGMENTS.length);
  assert.equal(catalog.inboundIntentThemes.length, INBOUND_INTENT_THEMES.length);
  assert.ok(catalog.inboundIntentThemes.some(x => x.key === 'confidence'));
  assert.ok(catalog.inboundIntentThemes.some(x => x.key === 'life-reset'));
});

test('campaign seeds use professional criteria and supervised outreach', () => {
  const seeds = transformationCampaignSeeds({ geography: 'United States' });
  assert.equal(seeds.length, OUTBOUND_SEGMENTS.length);
  for (const seed of seeds) {
    assert.equal(seed.sendPolicy, 'supervised');
    assert.equal(seed.objective, 'book_meetings');
    assert.equal(seed.icp.geography, 'United States');
    assert.ok(Array.isArray(seed.icp.titles));
    assert.ok(seed.icp.titles.length > 0);
    assert.equal(seed.filters.professionalCriteriaOnly, true);
    assert.deepEqual(seed.exclusions, SELF_DECLARED_ONLY);
  }
});

test('life transformation intake is an explicit consent lane', () => {
  assert.equal(LANES['life-transformation'].brand, 'Lion Elite');
  const capture = buildCapture({
    lane: 'life-transformation',
    name: 'Test Person',
    email: 'person@example.com',
    source: 'life-audit:confidence',
    emailMarketingConsent: true,
    smsMarketingConsent: false
  }, { now: '2026-10-06T04:00:00.000Z' });

  assert.equal(capture.lane, 'life-transformation');
  assert.equal(capture.source, 'life-audit:confidence');
  assert.equal(capture.emailMarketingConsent, true);
  assert.equal(capture.smsMarketingConsent, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adsForBrand } = require('../lib/ads/ad-copy');
const { platformEligibility, buildUtm, buildLaunchPlan } = require('../lib/ads/ad-launch-plan');

test('every Beauty ad variant passes coaching compliance (Meta-ready copy)', () => {
  const ads = adsForBrand('beauty');
  assert.ok(ads.length >= 3, 'want 3+ variants to test');
  for (const ad of ads) {
    assert.equal(ad.approved, true, `${ad.id}: ${JSON.stringify(ad.compliance.blockers)}`);
  }
});

test('Beauty ads carry no peptide/medical/guarantee language (brand separation)', () => {
  for (const ad of adsForBrand('beauty')) {
    assert.doesNotMatch(ad.primaryText, /peptide|retatrutide|guarantee|cure|treat|lose \d+ ?(lbs|pounds)/i);
  }
});

test('every Wellness ad variant passes RUO compliance and carries the disclaimer', () => {
  for (const ad of adsForBrand('wellness')) {
    assert.equal(ad.approved, true, `${ad.id}: ${JSON.stringify(ad.compliance.blockers)}`);
    assert.match(ad.primaryText, /laboratory research purposes only/);
  }
});

test('platform gate: research-only is INELIGIBLE on Meta/Google/TikTok', () => {
  for (const platform of ['meta', 'google', 'tiktok']) {
    const r = platformEligibility(platform, 'research-only');
    assert.equal(r.eligible, false, `${platform} should reject research-only`);
    assert.match(r.reason, /prohibit|restrict|ban|drug/i);
  }
});

test('platform gate: coaching IS eligible on Meta', () => {
  assert.equal(platformEligibility('meta', 'coaching').eligible, true);
});

test('buildLaunchPlan refuses a Wellness/Meta combo and routes it away', () => {
  const plan = buildLaunchPlan({ brand: 'wellness', complianceMode: 'research-only', platform: 'meta' });
  assert.equal(plan.eligible, false);
  assert.match(plan.recommendation, /Do NOT run this on Meta/);
});

test('buildLaunchPlan produces a Beauty/Meta campaign with tracked landing URL', () => {
  const plan = buildLaunchPlan({
    brand: 'beauty', complianceMode: 'coaching', platform: 'meta',
    dailyBudget: 30, landingUrl: 'https://lionelitebeauty.com/coaching'
  });
  assert.equal(plan.eligible, true);
  assert.equal(plan.campaign.dailyBudgetUsd, 30);
  assert.equal(plan.campaign.adSets.length, 3);
  assert.match(plan.campaign.trackedLandingUrl, /utm_source=meta/);
  assert.match(plan.campaign.trackedLandingUrl, /utm_campaign=beauty-meta-/);
  // Money actions must be surfaced as owner-only.
  assert.ok(plan.ownerActionsToGoLive.some((s) => /owner only/i.test(s)));
});

test('buildUtm requires source and campaign', () => {
  assert.throws(() => buildUtm({ medium: 'paid' }), /source and campaign/);
  assert.match(buildUtm({ source: 'meta', campaign: 'x' }), /utm_source=meta&utm_medium=paid&utm_campaign=x/);
});

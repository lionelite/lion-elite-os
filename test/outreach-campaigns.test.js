'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CAMPAIGNS, MED_SPA_DISCOVERY_TARGET, assertSafeguards, getCampaign } = require('../lib/outreach/campaigns');
const { buildResearchSupplyEmail, buildReorderEmail } = require('../lib/outreach/campaign-emails');
const { selectMedSpaProspects, selectReorderCustomers, matchesNiche } = require('../lib/outreach/campaign-selectors');

// ---- registry / safeguard invariants ----

test('both authorized campaigns are research-only and keep every safeguard', () => {
  for (const c of Object.values(CAMPAIGNS)) {
    assert.equal(c.complianceMode, 'research-only');
    assert.equal(c.safeguards.complianceValidation, true);
    assert.equal(c.safeguards.suppressionCheck, true);
    assert.equal(c.safeguards.dailyQuota, true);
    assert.equal(c.safeguards.killSwitch, true);
  }
});

test('a consumer campaign that omits unsubscribe/postal address is rejected', () => {
  assert.throws(() => assertSafeguards({
    id: 'bad', audienceType: 'consumer', complianceMode: 'research-only',
    safeguards: { complianceValidation: true, suppressionCheck: true, dailyQuota: true, killSwitch: true }
  }), /cannot skip safeguards: unsubscribe, postalAddress/);
});

test('a campaign not in research-only mode is rejected (RUO posture enforced)', () => {
  assert.throws(() => assertSafeguards({
    id: 'bad2', audienceType: 'business', complianceMode: 'coaching',
    safeguards: { complianceValidation: true, suppressionCheck: true, dailyQuota: true, killSwitch: true }
  }), /must use research-only compliance mode/);
});

test('med-spa discovery target only enriches a business\'s own site (no data broker)', () => {
  assert.equal(MED_SPA_DISCOVERY_TARGET.enrichFromOwnSiteOnly, true);
  assert.equal(MED_SPA_DISCOVERY_TARGET.campaignId, 'med_spa_research_supply');
  assert.ok(MED_SPA_DISCOVERY_TARGET.nicheKeywords.includes('med spa'));
});

// ---- B2B research-supply email ----

test('research-supply email passes RUO compliance and carries the disclaimer', () => {
  const draft = buildResearchSupplyEmail({ businessName: 'Radiance Med Spa', contactName: 'Dana' });
  assert.equal(draft.approved, true, JSON.stringify(draft.compliance.blockers));
  assert.match(draft.body, /laboratory research purposes only/);
  assert.match(draft.body, /Radiance Med Spa/);
  assert.match(draft.body, /Hi Dana,/);
});

test('research-supply email contains no human-use, dosing, or transformation language', () => {
  const { body } = buildResearchSupplyEmail({ businessName: 'X Aesthetics' });
  assert.doesNotMatch(body, /inject|dose|\bmg\b|protocol|treat|cure|weight loss|muscle growth|helps you/i);
});

test('research-supply email requires a business name', () => {
  assert.throws(() => buildResearchSupplyEmail({}), /businessName is required/);
});

// ---- B2C reorder email ----

test('reorder email passes RUO compliance and includes unsubscribe + postal address', () => {
  const draft = buildReorderEmail({
    firstName: 'Sam', reorderUrl: 'https://lionelitewellness.com/reorder',
    unsubscribeUrl: 'https://lionelitewellness.com/unsubscribe?id=1',
    postalAddress: 'Lion Elite Wellness, 123 Example St, Cleveland, OH 44100'
  });
  assert.equal(draft.approved, true, JSON.stringify(draft.compliance.blockers));
  assert.match(draft.body, /laboratory research purposes only/);
  assert.match(draft.body, /unsubscribe/i);
  assert.match(draft.body, /Cleveland, OH/);
  assert.equal(draft.canSpam.unsubscribe, 'https://lionelitewellness.com/unsubscribe?id=1');
});

test('reorder email refuses to build without CAN-SPAM unsubscribe + postal address', () => {
  assert.throws(() => buildReorderEmail({ firstName: 'Sam', postalAddress: 'addr' }), /unsubscribe/i);
  assert.throws(() => buildReorderEmail({ firstName: 'Sam', unsubscribeUrl: 'u' }), /postal address/i);
});

test('reorder email carries no human-use or benefit-claim language', () => {
  const { body } = buildReorderEmail({ firstName: 'Sam', unsubscribeUrl: 'u', postalAddress: 'a' });
  assert.doesNotMatch(body, /inject|dose|\bmg\b|your protocol|take it|you will feel|boost your|improve your/i);
});

// ---- selectors ----

const medSpaProspect = (id, category, extra = {}) => ({
  prospectId: id, status: 'active', stage: 'new', score: 80,
  business: { name: `${id} Co`, category }, contact: { email: `${id}@example.com` }, ...extra
});

test('selectMedSpaProspects keeps niche matches and explains off-niche skips', () => {
  const prospects = [
    medSpaProspect('a', 'Medical Spa'),
    medSpaProspect('b', 'Aesthetics Clinic'),
    medSpaProspect('c', 'Auto Repair'),
    medSpaProspect('d', 'Med Spa', { status: 'suppressed' })
  ];
  const { eligible, skipped } = selectMedSpaProspects(prospects);
  const ids = eligible.map((p) => p.prospectId).sort();
  assert.deepEqual(ids, ['a', 'b']);
  assert.ok(skipped.some((s) => s.prospectId === 'c' && s.reason === 'off_niche'));
  assert.ok(skipped.some((s) => s.prospectId === 'd' && s.reason === 'suppressed'));
});

test('matchesNiche is case-insensitive across name/category/description', () => {
  assert.equal(matchesNiche({ business: { name: 'Glow WELLNESS CENTER' } }, ['wellness center']), true);
  assert.equal(matchesNiche({ business: { category: 'bakery' } }, ['med spa']), false);
});

test('selectReorderCustomers honors cooldown, suppression, opt-out, and prior purchase', () => {
  const now = Date.parse('2026-07-25T00:00:00Z');
  const day = 86400000;
  const customers = [
    { prospectId: 'old', contact: { email: 'o@x.com' }, lastPurchaseAt: new Date(now - 60 * day).toISOString() },
    { prospectId: 'recent', contact: { email: 'r@x.com' }, lastPurchaseAt: new Date(now - 10 * day).toISOString() },
    { prospectId: 'supp', contact: { email: 's@x.com' }, suppressed: true, lastPurchaseAt: new Date(now - 90 * day).toISOString() },
    { prospectId: 'out', contact: { email: 'u@x.com' }, optedOut: true, lastPurchaseAt: new Date(now - 90 * day).toISOString() },
    { prospectId: 'never', contact: { email: 'n@x.com' } }
  ];
  const { eligible, skipped } = selectReorderCustomers(customers, { now });
  assert.deepEqual(eligible.map((c) => c.prospectId), ['old']);
  const reason = (id) => skipped.find((s) => s.prospectId === id).reason;
  assert.equal(reason('recent'), 'within_cooldown');
  assert.equal(reason('supp'), 'suppressed');
  assert.equal(reason('out'), 'opted_out');
  assert.equal(reason('never'), 'no_prior_purchase');
});

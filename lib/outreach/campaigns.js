'use strict';

// Outreach campaign registry (owner amendment 2026-07-25).
//
// Two authorized campaigns beyond the original B2B partnership outreach:
//   - med_spa_research_supply (B2B): introduce Lion Elite Wellness as a
//     RESEARCH-USE-ONLY peptide supplier to med spas / aesthetics / wellness
//     clinics. Content is research-supply framing only — no human-use.
//   - client_research_reorder (B2C): remind EXISTING research customers that
//     their prior research-grade items are available to reorder. New consumer
//     send path, owner-authorized 2026-07-25.
//
// SAFEGUARD INVARIANT: every campaign MUST run the full governed pipeline —
// fail-closed RUO compliance validation, suppression re-check, transactional
// daily quota, Redis kill switch, and (for consumer/B2C) a working unsubscribe
// + postal address. `assertSafeguards` refuses to register a campaign that
// tries to skip any of them, so a campaign can never be defined "around" the
// controls. Nothing here flips the send switch — sending stays fail-closed on
// the owner-set env vars.

const REQUIRED_SAFEGUARDS = Object.freeze(['complianceValidation', 'suppressionCheck', 'dailyQuota', 'killSwitch']);
// Consumer campaigns additionally require CAN-SPAM controls.
const CONSUMER_REQUIRED_SAFEGUARDS = Object.freeze([...REQUIRED_SAFEGUARDS, 'unsubscribe', 'postalAddress']);

function assertSafeguards(campaign) {
  const required = campaign.audienceType === 'consumer' ? CONSUMER_REQUIRED_SAFEGUARDS : REQUIRED_SAFEGUARDS;
  const safeguards = campaign.safeguards || {};
  const missing = required.filter((key) => safeguards[key] !== true);
  if (missing.length) {
    throw new Error(`Campaign "${campaign.id}" cannot skip safeguards: ${missing.join(', ')}`);
  }
  if (campaign.complianceMode !== 'research-only') {
    throw new Error(`Campaign "${campaign.id}" must use research-only compliance mode (RUO posture).`);
  }
  return campaign;
}

const CAMPAIGNS = Object.freeze({
  med_spa_research_supply: assertSafeguards({
    id: 'med_spa_research_supply',
    audienceType: 'business',
    complianceMode: 'research-only',
    emailBuilder: 'researchSupply',
    offer: 'research-grade peptide supply (RUO): batch-specific third-party testing, certificates of analysis, clear research-use-only labeling, reliable fulfillment.',
    // Niche match for selecting/discovering the right businesses.
    nicheKeywords: Object.freeze(['med spa', 'medspa', 'medical spa', 'aesthetic', 'aesthetics', 'wellness clinic', 'wellness center', 'anti-aging clinic', 'rejuvenation', 'iv therapy', 'regenerative']),
    safeguards: { complianceValidation: true, suppressionCheck: true, dailyQuota: true, killSwitch: true }
  }),
  // Immediate welcome for someone who opted in at the storefront's gated
  // access form. Consumer audience, so unsubscribe + postal address are
  // required by assertSafeguards below and cannot be omitted.
  gated_lead_welcome: assertSafeguards({
    id: 'gated_lead_welcome',
    audienceType: 'consumer',
    complianceMode: 'research-only',
    emailBuilder: 'welcome',
    offer: 'personal introduction and research documentation for someone who requested gated access (RUO).',
    requiresExplicitOptIn: true, // only leads with emailMarketingConsent === true
    welcomeCooldownDays: 365,    // a welcome is once per person, not a recurring nudge
    safeguards: { complianceValidation: true, suppressionCheck: true, dailyQuota: true, killSwitch: true, unsubscribe: true, postalAddress: true }
  }),
  client_research_reorder: assertSafeguards({
    id: 'client_research_reorder',
    audienceType: 'consumer',
    complianceMode: 'research-only',
    emailBuilder: 'reorder',
    offer: 'reminder that previously purchased research-grade items are available to reorder for laboratory research purposes only.',
    reorderCooldownDays: 45, // do not nudge a customer to reorder more often than this
    safeguards: { complianceValidation: true, suppressionCheck: true, dailyQuota: true, killSwitch: true, unsubscribe: true, postalAddress: true }
  })
});

// Med-spa discovery target profile — the niche criteria the discovery worker
// consumes to find candidate businesses from approved public business sources.
// (Requires DATABASE_URL + the discovery worker to be live on Render; this is
// the targeting config, not a running crawler.)
const MED_SPA_DISCOVERY_TARGET = Object.freeze({
  campaignId: 'med_spa_research_supply',
  sourcePolicy: 'approved_public_business_sources',
  nicheKeywords: CAMPAIGNS.med_spa_research_supply.nicheKeywords,
  batchSize: 25,
  enrichFromOwnSiteOnly: true // only a business's OWN published contact email — no data broker
});

function getCampaign(id) {
  const c = CAMPAIGNS[id];
  if (!c) throw new Error(`Unknown campaign: ${id}`);
  return c;
}

module.exports = {
  REQUIRED_SAFEGUARDS,
  CONSUMER_REQUIRED_SAFEGUARDS,
  CAMPAIGNS,
  MED_SPA_DISCOVERY_TARGET,
  assertSafeguards,
  getCampaign
};

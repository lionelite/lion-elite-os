'use strict';

// Paid-ads launch plan: platform-eligibility gate + campaign structure +
// tracking. The gate is the important part — it encodes, in code, that
// peptide/research-compound product ads are NOT eligible on Meta (Meta
// prohibits unsafe-supplement / research-chemical advertising; an RUO
// disclaimer does not exempt the product category, and violating it risks a
// permanent ad-account ban). So the Wellness brand is routed away from Meta,
// and the Beauty coaching service — a Meta-eligible offer — is the Meta engine.
//
// Nothing here spends money or launches anything. It produces the plan a human
// loads into Ads Manager and presses publish on.

// Platforms where a brand's product category is allowed to advertise.
const PLATFORM_POLICY = Object.freeze({
  meta: { prohibits: ['research-only'], note: 'Meta prohibits unsafe-supplement / research-chemical ads; peptide product ads risk account ban.' },
  google: { prohibits: ['research-only'], note: 'Google Ads restricts unapproved/ research-chemical substances.' },
  tiktok: { prohibits: ['research-only'], note: 'TikTok prohibits drugs/supplement claims of this class.' }
});

/**
 * Is `brand` (by its compliance mode) eligible to advertise on `platform`?
 * Returns { eligible, reason }.
 */
function platformEligibility(platform, complianceMode) {
  const policy = PLATFORM_POLICY[platform];
  if (!policy) return { eligible: false, reason: `unknown platform: ${platform}` };
  if (policy.prohibits.includes(complianceMode)) {
    return { eligible: false, reason: policy.note };
  }
  return { eligible: true, reason: null };
}

// UTM tracking so every click is attributable — attribution/measurement is the
// single most common lever among the swipe-file winners. No tracking, no
// scaling decisions.
function buildUtm({ source, medium = 'paid', campaign, content = '' }) {
  if (!source || !campaign) throw new Error('utm source and campaign are required');
  const params = new URLSearchParams({
    utm_source: source,
    utm_medium: medium,
    utm_campaign: campaign
  });
  if (content) params.set('utm_content', content);
  return params.toString();
}

/**
 * Build a launch plan for a brand on a platform. Refuses (eligible:false) to
 * plan a prohibited brand/platform combo rather than produce a ban-bound
 * campaign.
 *
 * @param {object} p
 * @param {'beauty'|'wellness'} p.brand
 * @param {string} p.complianceMode  'coaching' | 'research-only'
 * @param {string} p.platform        'meta' | 'google' | 'tiktok'
 * @param {number} p.dailyBudget     USD/day (informational; humans set spend)
 * @param {string} p.landingUrl      the page the ad lands on (one system!)
 */
function buildLaunchPlan({ brand, complianceMode, platform = 'meta', dailyBudget = 20, landingUrl = '' }) {
  const eligibility = platformEligibility(platform, complianceMode);
  if (!eligibility.eligible) {
    return {
      brand, platform, eligible: false, reason: eligibility.reason,
      recommendation: complianceMode === 'research-only'
        ? 'Do NOT run this on Meta/Google/TikTok. Route research supply to compliant channels (email to opted-in research buyers, its own COA-forward landing page, direct/affiliate) — never a prohibited-category ad.'
        : 'Choose an eligible platform.'
    };
  }
  const campaignName = `${brand}-${platform}-${new Date().toISOString().slice(0, 10)}`;
  const utm = landingUrl ? buildUtm({ source: platform, campaign: campaignName }) : null;
  return {
    brand,
    platform,
    eligible: true,
    campaign: {
      name: campaignName,
      objective: 'sales', // conversions; move to sales objective once the pixel has data
      budgetStrategy: 'CBO', // campaign budget optimization across ad sets
      dailyBudgetUsd: dailyBudget,
      adSets: [
        { name: 'broad', audience: 'broad + advantage+ (let the algo find buyers)', note: 'primary scaling ad set' },
        { name: 'interest', audience: 'coaching / fitness / accountability interests', note: 'test vs broad' },
        { name: 'retargeting', audience: 'site visitors + engagers, 30d', note: 'warm; highest ROAS, small budget' }
      ],
      creativeTestCount: 3, // test 3 variants, scale the winner (ad-design testing)
      trackedLandingUrl: landingUrl && utm ? `${landingUrl}${landingUrl.includes('?') ? '&' : '?'}${utm}` : null
    },
    adLandingSystem: 'The ad and the landing page are ONE system: the page headline must echo the winning ad’s promise. Congruence is a top winner pattern.',
    ownerActionsToGoLive: [
      'Connect billing / payment method in Ads Manager (spend — owner only).',
      'Install the Meta pixel / Conversions API on the landing site and verify events.',
      'Load the approved ad variants + creative, set the daily budget, and press Publish (owner only).'
    ]
  };
}

module.exports = { PLATFORM_POLICY, platformEligibility, buildUtm, buildLaunchPlan };

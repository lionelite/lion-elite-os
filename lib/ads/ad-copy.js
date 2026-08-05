'use strict';

// Launch-ready paid-ad copy for both brands, every variant validated through
// the same fail-closed compliance engine the organic content uses. Multiple
// variants per brand on purpose — ad-design/creative testing is one of the
// strongest patterns among the swipe-file winners (test 3-5, scale the one
// that wins, kill the rest).
//
// Beauty = coaching mode (Meta-eligible service). Wellness = research-only
// (RUO; NOT for Meta — see lib/ads/ad-launch-plan.js platform gate).

const { validateContent } = require('../social/social-compliance');

// --- Lion Elite Beauty (coaching/training) — Meta-eligible ---
const BEAUTY_ADS = [
  {
    id: 'beauty-consistency',
    primaryText: 'Six months in, our clients keep showing up — because structure beats motivation. Lion Elite Beauty builds the personalized coaching and accountability that keep you consistent long after the hype fades.',
    headline: 'Coaching that keeps you consistent',
    description: 'Personalized, high-touch, disciplined.',
    cta: 'Learn more'
  },
  {
    id: 'beauty-accountability',
    primaryText: 'Motivation is unreliable. A coach who holds you to the plan is not. Lion Elite Beauty gives you a personalized roadmap and real accountability between sessions — the part most people are missing.',
    headline: 'Your plan. Real accountability.',
    description: 'Structure, follow-through, results you build.',
    cta: 'Sign up'
  },
  {
    id: 'beauty-premium',
    primaryText: 'Premium coaching for people who are done starting over. We keep it personal, direct, and disciplined — support that helps you stay the course, not another program you quit in three weeks.',
    headline: 'Done starting over?',
    description: 'Premium, personal, disciplined coaching.',
    cta: 'Learn more'
  }
];

// --- Lion Elite Wellness (research supply) — RUO, NOT for Meta ---
const WELLNESS_ADS = [
  {
    id: 'wellness-documentation',
    primaryText: 'Research-grade peptides for laboratory research purposes only. Every batch ships with a third-party certificate of analysis and clear research-use-only labeling. Verifiable documentation is the whole model.',
    headline: 'Research-grade supply, documented',
    description: 'Batch COAs. Research use only.',
    cta: 'Learn more'
  },
  {
    id: 'wellness-coa',
    primaryText: 'If you want real COAs, look for verifiable ones. Lion Elite Wellness supplies research compounds for laboratory research purposes only, with batch-specific third-party testing on every item.',
    headline: 'Real COAs, every batch',
    description: 'Third-party tested. Research use only.',
    cta: 'Learn more'
  }
];

function brandConfig(brand) {
  if (brand === 'beauty') return { ads: BEAUTY_ADS, complianceMode: 'coaching' };
  if (brand === 'wellness') return { ads: WELLNESS_ADS, complianceMode: 'research-only' };
  throw new Error(`Unknown brand: ${brand} (use 'beauty' or 'wellness')`);
}

// Validate one ad's copy. The primary text is the field that carries claims,
// so it is what the compliance engine checks; the RUO disclaimer is only hard-
// required for research-only copy.
function validateAd(ad, complianceMode) {
  return validateContent({
    text: ad.primaryText,
    complianceMode,
    requireDisclaimer: complianceMode === 'research-only'
  });
}

/**
 * Return the compliance-approved ad variants for a brand, each annotated with
 * its compliance result. Callers should only ship `approved` variants.
 */
function adsForBrand(brand) {
  const { ads, complianceMode } = brandConfig(brand);
  return ads.map((ad) => {
    const compliance = validateAd(ad, complianceMode);
    return { ...ad, brand, complianceMode, compliance, approved: compliance.approved };
  });
}

module.exports = { BEAUTY_ADS, WELLNESS_ADS, brandConfig, validateAd, adsForBrand };

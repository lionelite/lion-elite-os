'use strict';

/**
 * Picks the right e-mail builder for an outreach job.
 *
 * Until this existed the email worker built EVERY draft with
 * lib/email-generation.js, a Lion Elite *Beauty* coaching/referral partnership
 * pitch signed with the Beauty phone and website. Discovery stores med spas and
 * clinics as prospects, so the moment OUTREACH_SEND_ENABLED was set every clinic
 * would have received a Beauty coaching e-mail: wrong brand, wrong offer, and
 * nothing to do with the authorized med_spa_research_supply campaign. The
 * campaign's own builder (lib/outreach/campaign-emails.js) was registered but
 * nothing called it.
 *
 * Routing is by campaign first, then by what the stored business is:
 *   - campaignId med_spa_research_supply               → clinic supply sequence
 *   - discovery prospect whose niche is a clinic type  → clinic supply sequence
 *   - anything else (gyms, studios, partners)          → the existing Beauty builder
 */

const { buildEmail, scoreEmail } = require('../email-generation');
const { CAMPAIGN_ID: CLINIC_CAMPAIGN, buildClinicSupplyEmail } = require('./clinic-supply-email');

const DISCOVERY_CAMPAIGN = 'osm-business-discovery';
const CLINIC_NICHE = /med[\s-]?spa|medi[\s-]?spa|clinic|aesthetic|esthetic|dermatolog|surgery|surgeon|wellness|longevity|anti-?aging|\biv\b|hydration|regenerat/i;

function isClinicSupply(context = {}) {
  if (context.campaignId === CLINIC_CAMPAIGN) return true;
  return context.campaignId === DISCOVERY_CAMPAIGN && CLINIC_NICHE.test(String(context.category || ''));
}

/**
 * @returns {{ route: 'clinic_supply'|'beauty_partnership', draft, quality }}
 * `draft.approved` is false whenever the draft must not be sent.
 */
function draftForContext(context = {}) {
  if (isClinicSupply(context)) {
    const built = buildClinicSupplyEmail({
      businessName: context.businessName,
      contactName: context.contactName,
      category: context.category,
      whyTargeted: context.whyTargeted,
      market: context.market || context.location,
    }, { step: Number(context.sequenceStep || 1) });
    const draft = { ...built, approved: built.approved && built.quality.blockers.length === 0 };
    return { route: 'clinic_supply', draft, quality: built.quality };
  }
  const draft = buildEmail(context);
  return { route: 'beauty_partnership', draft, quality: scoreEmail(draft, context) };
}

module.exports = { isClinicSupply, draftForContext, CLINIC_CAMPAIGN, DISCOVERY_CAMPAIGN };

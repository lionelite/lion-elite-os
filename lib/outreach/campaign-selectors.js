'use strict';

// Audience selection for the two campaigns. Pure and testable: given stored
// prospect/customer records, decide who is eligible and explain every skip.
// Selection never sends — eligible records still flow through the governed
// email → validation → dispatch chain (suppression, quota, kill switch).

const { selectOutreachCandidates, hasEmail } = require('../outreach-enqueue');
const { getCampaign } = require('./campaigns');

function matchesNiche(prospect, keywords) {
  const b = prospect.business || {};
  const haystack = [b.name, b.displayName, b.category, b.niche, b.industry, b.description]
    .filter(Boolean).join(' ').toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

/**
 * B2B med-spa selection: start from the standard outreach-eligible set
 * (excludes already-contacted/suppressed/no-email), then keep only businesses
 * whose profile matches the med-spa/aesthetics/wellness niche.
 */
function selectMedSpaProspects(prospects = []) {
  const { nicheKeywords } = getCampaign('med_spa_research_supply');
  const { eligible, skipped } = selectOutreachCandidates(prospects);
  const kept = [];
  const offNiche = [];
  for (const p of eligible) {
    if (matchesNiche(p, nicheKeywords)) kept.push(p);
    else offNiche.push({ prospectId: p.prospectId, reason: 'off_niche' });
  }
  return { eligible: kept, skipped: [...skipped, ...offNiche] };
}

/**
 * B2C reorder selection: EXISTING customers whose last purchase is older than
 * the campaign cooldown, who are not suppressed, not opted out, and have an
 * email. This is the one place we intentionally target `customer`-stage
 * records — gated by cooldown + suppression + opt-out so it can't become spam.
 */
function selectReorderCustomers(customers = [], { now = Date.now() } = {}) {
  const { reorderCooldownDays } = getCampaign('client_research_reorder');
  const cooldownMs = reorderCooldownDays * 86400000;
  const eligible = [];
  const skipped = [];
  for (const c of customers) {
    let reason = null;
    if (c.status === 'suppressed' || c.suppressed === true) reason = 'suppressed';
    else if (c.optedOut === true || c.unsubscribed === true) reason = 'opted_out';
    else if (!hasEmail(c)) reason = 'no_email';
    else if (!c.lastPurchaseAt) reason = 'no_prior_purchase';
    else {
      const last = Date.parse(c.lastPurchaseAt);
      if (Number.isNaN(last)) reason = 'bad_last_purchase_date';
      else if (now - last < cooldownMs) reason = 'within_cooldown';
    }
    if (reason) skipped.push({ prospectId: c.prospectId, reason });
    else eligible.push(c);
  }
  // Oldest purchase first — remind the ones most overdue to restock.
  eligible.sort((a, b) => Date.parse(a.lastPurchaseAt) - Date.parse(b.lastPurchaseAt));
  return { eligible, skipped };
}

module.exports = { matchesNiche, selectMedSpaProspects, selectReorderCustomers };

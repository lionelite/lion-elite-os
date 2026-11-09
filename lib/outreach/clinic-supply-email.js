'use strict';

/**
 * Per-clinic e-mail sequence for the med_spa_research_supply campaign.
 *
 * Built from two sources in this repo rather than invented:
 *   - sales/master-sales-framework.md: relevance before pitch, credibility in one
 *     sentence, one discovery question, a single specific next step, no
 *     manufactured urgency or unsupported claims (Universal Sales Rules 1-15).
 *   - docs/clinical-decision-maker-pilot.md: the offer. "Send us the
 *     specifications and quantities for one product you already purchase, and
 *     we'll prepare a side-by-side quote with supporting quality documentation."
 *     It is mutually beneficial by construction: the clinic gets a free benchmark
 *     of its current supplier whether or not it switches, and we get a real
 *     quote request instead of a cold "partnership" pitch.
 *
 * What is deliberately NOT here, and why:
 *   - No reference to a clinic's patient services (peptide therapy, weight
 *     management, hormones). Tying a Research-Use-Only product to what a clinic
 *     does for patients is exactly the positioning the pilot doc forbids ("Do not
 *     market research-use-only products for patient treatment"), whatever the
 *     clinic's website says.
 *   - No savings claim. The pilot doc only allows savings "when supported for the
 *     specific product and comparison", and a cold e-mail has no comparison yet.
 *   - No guessed contact names. The harvested list carries business inboxes, so
 *     the greeting addresses the team unless a name is supplied.
 *
 * Personalization is by segment (what kind of practice), market (which city)
 * and business name, which is everything the harvested record actually knows.
 * Every draft is run through the fail-closed RUO validator; `approved: false`
 * means it must not be sent. The postal address and List-Unsubscribe header are
 * added at delivery by lib/email-delivery.js.
 */

const crypto = require('crypto');
const { validateContent, RESEARCH_DISCLAIMER_PHRASE } = require('../social/social-compliance');
const { WELLNESS_SIGNATURE } = require('./campaign-emails');

const CAMPAIGN_ID = 'med_spa_research_supply';

const clean = v => String(v || '').replace(/\s+/g, ' ').trim();

/**
 * Segment from the record's category, targeting reason and name. Order matters:
 * the first match wins, most specific first.
 */
const SEGMENTS = Object.freeze([
  { id: 'plastic_surgery', test: /plastic|cosmetic surg|facial surg/i, practice: 'plastic and cosmetic surgery practices' },
  { id: 'dermatology', test: /dermatolog|\bderm\b|skin (clinic|institute)/i, practice: 'dermatology practices' },
  { id: 'iv_hydration', test: /\biv\b|hydration|drip/i, practice: 'IV and hydration clinics' },
  { id: 'longevity', test: /longevity|anti-?aging|vitality|regenerat|rejuven/i, practice: 'longevity and regenerative clinics' },
  { id: 'med_spa', test: /med[\s-]?spa|medi[\s-]?spa|medical spa|aesthetic|esthetic/i, practice: 'med spas and aesthetics practices' },
  { id: 'wellness', test: /wellness|integrative|functional/i, practice: 'wellness clinics' },
]);
const DEFAULT_SEGMENT = Object.freeze({ id: 'clinic', test: null, practice: 'independent clinics' });

function segmentFor(input = {}) {
  const haystack = [input.category, input.whyTargeted, input.businessName].map(clean).join(' ');
  return SEGMENTS.find(s => s.test.test(haystack)) || DEFAULT_SEGMENT;
}

/** Markets whose slug does not read as a place name when title-cased. */
const MARKET_NAMES = Object.freeze({
  'delray-boynton-fl': 'Delray Beach and Boynton Beach',
  'northern-nj': 'northern New Jersey',
});

/** "naples-fl" → "Naples", "fort-lauderdale-fl" → "Fort Lauderdale". */
function cityFromMarket(market) {
  const slug = clean(market).toLowerCase();
  if (MARKET_NAMES[slug]) return MARKET_NAMES[slug];
  const parts = slug.split('-').filter(Boolean);
  if (parts.length < 2) return '';
  return parts.slice(0, -1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function withCompliance(draft) {
  const compliance = validateContent({ text: draft.body, complianceMode: 'research-only', requireDisclaimer: true });
  const blockers = compliance.blockers.map(b => b.code);
  return { ...draft, compliance, approved: compliance.approved, quality: scoreClinicEmail(draft, blockers) };
}

/**
 * Objective checks against the framework's Quality-Control Checklist. Scored so
 * the outreach worker's existing minimum-score gate applies to this campaign
 * too, and so a template edit that drops the offer or the question fails loudly.
 */
function scoreClinicEmail(draft, complianceBlockers = []) {
  const body = draft.body;
  const paragraphs = body.split('\n\n');
  const dimensions = {
    relevance: body.includes(draft.personalization.businessName) ? 100 : 0,
    segmentFit: draft.personalization.segment !== 'clinic' ? 100 : 70,
    offerClarity: /side-by-side quote|benchmark|COA template|close the loop/i.test(body) ? 100 : 0,
    discoveryQuestion: paragraphs.some(p => /\?\s*$/.test(p.trim())) ? 100 : 0,
    specificNextStep: /reply with|reply "|just reply/i.test(body) ? 100 : 40,
    respectsOptOut: /won't (contact|e-mail|email) you again|you won't hear from me/i.test(body) ? 100 : 0,
    ruoDisclaimer: body.includes(RESEARCH_DISCLAIMER_PHRASE) ? 100 : 0,
    readability: body.length <= 1400 ? 100 : 60,
  };
  const blockers = [...complianceBlockers];
  if (!dimensions.relevance) blockers.push('missing_business_name');
  if (!dimensions.offerClarity) blockers.push('missing_offer');
  if (!dimensions.respectsOptOut) blockers.push('missing_opt_out');
  if (!dimensions.ruoDisclaimer) blockers.push('missing_ruo_disclaimer');
  const values = Object.values(dimensions);
  return { score: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)), dimensions, blockers };
}

function signatureBlock(signature) {
  return `Best,\n${signature.name}\n${signature.brand}\n${signature.website}`;
}

/**
 * step 1: introduction + offer (day 0)
 * step 2: one useful thing, no new ask (day 3)
 * step 3: close the loop and let them choose (day 7)
 * Matches the pilot's proposed cadence; the sequence stops on any reply,
 * opt-out or bounce (enforced by suppression, not by this builder).
 */
function buildClinicSupplyEmail(input = {}, { step = 1 } = {}) {
  const businessName = clean(input.businessName);
  if (!businessName) throw new Error('businessName is required.');
  if (![1, 2, 3].includes(step)) throw new Error('step must be 1, 2 or 3');

  const segment = segmentFor(input);
  const city = cityFromMarket(input.market || input.location);
  const contactName = clean(input.contactName);
  const greeting = contactName ? `Hi ${contactName},` : `Hi ${businessName} team,`;
  const signature = { ...WELLNESS_SIGNATURE, ...(input.signature || {}) };
  const where = city ? ` in ${city}` : '';
  const optOut = `If this isn't relevant to ${businessName}, reply "no thanks" and I won't contact you again.`;
  const ruo = `Everything we supply is labeled for ${RESEARCH_DISCLAIMER_PHRASE}.`;

  let subject;
  let paragraphs;

  if (step === 1) {
    subject = `${businessName}: a side-by-side quote on one product you already buy`;
    paragraphs = [
      greeting,
      `I'm Alex with ${signature.brand}. I work with ${segment.practice}${where} on one narrow thing: making research-grade supply easier to source and easier to verify.`,
      `A simple offer: send me the specifications and order quantity for one research-grade product ${businessName} already buys, and I'll prepare a side-by-side quote with the batch documentation next to it. If it doesn't beat what you have, you still come away with a current benchmark for your existing supplier.`,
      `Every batch we supply carries independent third-party testing and a lot-matched certificate of analysis (COA). ${ruo}`,
      `Who looks after supplier decisions at ${businessName}, and what matters most to them: price, documentation, or delivery reliability?`,
      `If it's easier, just reply with the product and quantity and I'll handle the rest.`,
      signatureBlock(signature),
      optOut,
    ];
  } else if (step === 2) {
    subject = `Re: ${businessName}: a side-by-side quote on one product you already buy`;
    paragraphs = [
      greeting,
      `One thing worth checking whoever ${businessName} buys from: does every batch arrive with a COA that matches the lot number on the label, from a lab independent of the seller? It's the quickest way to tell documented supply from undocumented supply.`,
      `I'm happy to send our COA template so you can hold your current supplier's paperwork up against it. No quote or call needed for that.`,
      `Would that be useful, or is supplier documentation already well covered at ${businessName}?`,
      ruo,
      signatureBlock(signature),
      optOut,
    ];
  } else {
    subject = `Close the loop: ${businessName}`;
    paragraphs = [
      greeting,
      `I'll close the loop here so this doesn't sit in your inbox. The side-by-side quote stays open whenever it's useful: one product, your specifications, our documentation next to it.`,
      `If the timing is wrong, reply "later" and I'll check back next quarter. Is there someone else at ${businessName} I should speak with instead?`,
      ruo,
      signatureBlock(signature),
      `Otherwise, you won't hear from me again about this.`,
    ];
  }

  return withCompliance({
    campaignId: CAMPAIGN_ID,
    step,
    messageVersion: templateVersion(step),
    subject,
    body: paragraphs.join('\n\n'),
    signature,
    personalization: { businessName, contactName: contactName || null, segment: segment.id, city: city || null },
  });
}

/**
 * Version id that changes whenever the wording can change: a hash of the builder
 * source and every segment/market phrase it can insert. Approval in
 * lib/outreach/approved-message-versions.js is keyed on this, so editing the copy
 * produces an unapproved version instead of silently inheriting an approval.
 */
function templateVersion(step) {
  const source = [buildClinicSupplyEmail.toString(), JSON.stringify(SEGMENTS.map(s => [s.id, String(s.test), s.practice])),
    JSON.stringify(DEFAULT_SEGMENT), JSON.stringify(MARKET_NAMES), RESEARCH_DISCLAIMER_PHRASE].join('\n');
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 8);
  return `clinic-supply-v1-step${step}-${hash}`;
}

module.exports = { CAMPAIGN_ID, SEGMENTS, segmentFor, cityFromMarket, buildClinicSupplyEmail, scoreClinicEmail, templateVersion };

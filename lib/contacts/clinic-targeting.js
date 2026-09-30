'use strict';

// Is this business a plausible buyer of research-grade peptides?
//
// The discovery categories are OSM tags, and they are far too broad for this
// campaign. `shop=beauty` covers med spas and nail bars equally, and
// `amenity=clinic` covers aesthetics practices, urgent care, dialysis centres
// and an abortion provider — all four turned up in the first harvested list.
//
// That matters for three reasons, in order of how much they cost:
//
//   1. Sending Research-Use-Only peptide supply copy to an abortion clinic, a
//      paediatric practice or a veterinary office is not a wasted send, it is
//      an incident. Some of these exclusions exist so that never happens.
//   2. A nail bar will not reply, and a list padded with rows nobody converts
//      makes every downstream rate look worse than it is, which is how a
//      working campaign gets killed for underperforming.
//   3. Bounces and complaints from irrelevant recipients are what move a
//      sending domain's reputation, and reputation is shared across every
//      campaign the domain sends.
//
// Classification is by name and OSM category, deterministic and offline. It is
// a filter on who is worth a human's attention, not a judgement about any
// business — so it returns a tier and the reason, and `low` is kept rather than
// discarded, because a generically-named clinic may still be the right target
// and a person can tell in one look at the website.

// Practices whose core business is or adjoins injectable/infusion/hormone or
// longevity work — the ones an RUO peptide supplier is actually calling on.
const STRONG_SIGNALS = Object.freeze([
  'med spa', 'medspa', 'med-spa', 'medi spa', 'medispa', 'medical spa',
  'aesthetic', 'aesthetics', 'esthetic',
  'wellness', 'wellbeing', 'well-being',
  'anti-aging', 'anti aging', 'antiaging', 'age management',
  'rejuven', 'revitali', 'vitality', 'longevity', 'regenerative',
  'hormone', 'hrt', 'trt', 'testosterone', 'endocrin',
  'iv ', 'iv-', 'infusion', 'hydration', 'drip',
  'peptide', 'stem cell', 'prp', 'biohack',
  'weight loss', 'weightloss', 'body sculpt', 'bodysculpt', 'contour',
  'functional medicine', 'integrative', 'concierge medicine',
  'dermatolog', 'derm', 'plastic surgery', 'cosmetic surgery',
  'rheumatolog', 'sports medicine', 'recovery', 'optimiz'
]);

// Names that put a business outside this campaign regardless of its OSM tag.
// The first group is a compliance and judgement matter, the second is fit.
const NEVER_TARGET = Object.freeze([
  // Wrong and potentially harmful to contact about peptide supply.
  'preterm', 'planned parenthood', 'abortion',
  'paediatric', 'pediatric', 'children', 'childrens', 'kids',
  'veterinar', 'animal hospital', 'pet clinic',
  'dialysis', 'oncolog', 'cancer', 'hospice', 'palliative',
  'psychiatr', 'behavioral health', 'mental health', 'rehab', 'addiction', 'detox',
  'plasma', 'blood bank', 'blood center',
  // Clinical settings with no purchasing relationship to this product.
  'urgent care', 'emergency', 'hospital', 'dental', 'dentist', 'orthodont',
  'optical', 'optometr', 'ophthalm', 'eye care', 'vision center',
  'imaging', 'radiolog', 'laborator', 'diagnostic',
  'student health', 'university health', 'campus health',
  'free clinic', 'community health', 'public health',
  // Hospital systems and federally-qualified centres buy through procurement,
  // not from a research-supply introduction — and several turned up tiered as
  // medium on the strength of a bare "clinic" tag.
  'health center', 'health centre', 'health services', 'medical center',
  'medical centre', 'metrohealth', 'mercy health',
  // Therapy providers for developmental and behavioural conditions. Contacting
  // an autism services provider about peptide supply is the same category of
  // error as contacting a paediatric practice.
  'autism', 'aba therapy', 'childwise', 'developmental'
]);

// A university or government domain means a campus or public health service
// whatever the business is called. Checked on the website rather than the name,
// because "Wellness Center" reads as a perfect target until you see that its
// site is a .edu.
const INSTITUTIONAL_DOMAINS = Object.freeze(['.edu', '.gov', '.mil']);

// Beauty and personal-care trades that share the `shop=beauty` tag but do not
// buy research compounds.
const WRONG_TRADE = Object.freeze([
  'nail', 'manicure', 'pedicure',
  'hair', 'haircut', 'barber', 'braid', 'weave', 'extension', 'wig',
  'brow', 'eyebrow', 'lash', 'threading',
  'tan', 'tanning', 'spray tan',
  'wax', 'waxing', 'sugaring',
  'makeup', 'make-up', 'cosmetics store', 'beauty supply',
  'piercing', 'tattoo'
]);

// OSM categories that are medical by tag, so a bare name is still promising.
const MEDICAL_CATEGORIES = Object.freeze(['clinic', 'physiotherapy']);

// Name and website only — deliberately NOT the category.
//
// The OSM category string is literally "med-spa", so including it made
// text.includes('med-spa') true for every row in that category and tiered a
// nail bar as high fit on the strength of its own tag. The category is a
// separate, weaker signal and is consulted on its own below.
function haystack(business = {}) {
  return [business.name, business.website]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

// A domain concatenates words, so "glowvitamedspa.com" contains no word
// boundary before "medspa" and word-boundary matching misses it — which
// dropped a genuine med spa from the list. Names get boundary matching to stop
// mid-word coincidences; domains get substring matching, where a coincidence is
// far less likely because the term has to appear in a registered name.
function domainText(business = {}) {
  return String(business.website || '').toLowerCase();
}

// Match at a word start rather than anywhere in the string.
//
// Terms were written with a trailing space ('tan ', 'hair ') to stop `tan`
// firing inside `Titan`. That silently failed at the end of a string, so
// "Palm Beach Tan" tiered as a target. A leading word boundary does the job
// properly: it still matches plural and compound forms ("nails", "NailsLab")
// and still refuses a mid-word coincidence ("Titan", "chair").
function matched(text, list) {
  return list.filter(term => {
    const needle = term.trim();
    if (!needle) return false;
    if (/\s/.test(needle)) return text.includes(needle);
    return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);
  });
}

/**
 * Tier a business for the RUO peptide-supply campaign.
 *
 * Returns { tier, reasons, signals } where tier is one of:
 *   high    — names injectable/hormone/longevity/aesthetic medicine work
 *   medium  — medical by OSM tag, name does not say what kind
 *   low     — in a target category but nothing indicates fit
 *   exclude — wrong trade, or a practice this campaign must not contact
 */
function clinicRelevance(business = {}) {
  const text = haystack(business);
  const category = String(business.category || '').toLowerCase();

  const website = String(business.website || '').toLowerCase();
  const institutional = INSTITUTIONAL_DOMAINS.find(suffix => website.includes(suffix));
  if (institutional) {
    return {
      tier: 'exclude',
      reasons: [`Institutional site (${institutional}) — a campus or public health service, not a private clinic.`],
      signals: []
    };
  }

  const never = matched(text, NEVER_TARGET);
  if (never.length) {
    return {
      tier: 'exclude',
      reasons: [`Not a target for peptide supply (${never[0]}).`],
      signals: []
    };
  }

  const domain = domainText(business);
  const signals = [...new Set([
    ...matched(String(business.name || '').toLowerCase(), STRONG_SIGNALS),
    ...STRONG_SIGNALS.filter(term => !/\s/.test(term.trim()) && domain.includes(term.trim()))
  ])];

  // A wrong-trade term only excludes when nothing indicates clinical work. A
  // "Laser & Aesthetics" that also offers waxing is still an aesthetics
  // practice; a business whose whole name is a nail bar is not.
  const wrongTrade = matched(text, WRONG_TRADE);
  if (wrongTrade.length && !signals.length) {
    return {
      tier: 'exclude',
      reasons: [`Beauty trade rather than a clinic (${wrongTrade[0].trim()}).`],
      signals: []
    };
  }

  if (signals.length) {
    return {
      tier: 'high',
      reasons: [`Names ${signals.slice(0, 3).join(', ')}.`],
      signals
    };
  }

  if (MEDICAL_CATEGORIES.includes(category)) {
    return {
      tier: 'medium',
      reasons: ['Medical by OSM tag; the name does not say what kind. Check the site before sending.'],
      signals: []
    };
  }

  return {
    tier: 'low',
    reasons: ['In a target category, but nothing in the name indicates fit.'],
    signals: []
  };
}

/** Rank order for sorting a list so a human works the best rows first. */
const TIER_ORDER = Object.freeze({ high: 0, medium: 1, low: 2, exclude: 3 });

module.exports = {
  STRONG_SIGNALS,
  INSTITUTIONAL_DOMAINS,
  NEVER_TARGET,
  WRONG_TRADE,
  MEDICAL_CATEGORIES,
  TIER_ORDER,
  clinicRelevance
};

'use strict';

// Per-peptide image + caption catalog for the LEW "Peptide Info Series"
// (one research-education product spotlight per day).
//
// Two hard rules bake the compliance posture into the data itself:
//  1. Approved products only — every entry is on
//     lion-elite-wellness/product-master-list.md. Products off that list
//     (e.g. Testosterone Cypionate — a controlled substance — Melanotan II,
//     PT-141) are deliberately absent and must not be added without an
//     owner decision.
//  2. Research-education framing only — captions describe the RESEARCH AREA
//     a compound is studied in, never an effect in a person. Every caption
//     is verified against lib/social/social-compliance.js in the tests, so
//     a caption that drifts into human-use/transformation/dosing language
//     fails CI before it can ever publish.
//
// Image prompts render a premium labeled research vial (RUO aesthetic),
// never any on-image benefit/claim text.

const { WELLNESS_DISCLAIMER } = require('./brand-profiles');
const { buildCreativePrompt, headlineFor, flairForIndex } = require('./creative-template');

// Turn a research-area phrase into 2-3 short pathway chips for the left
// column, without inventing specific receptor claims.
function pathwaysFromArea(area = '') {
  return String(area)
    .replace(/\bresearch\b/gi, '')
    .split(/,|\band\b/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => s.replace(/\b\w/g, (c) => c.toUpperCase()));
}

// caption() enforces the compliant shape: research-area framing + a quality
// note + the mandatory RUO disclaimer. No dosing, no human-use verbs, no
// transformation/benefit language.
function caption(name, researchArea, note) {
  return (
    `${name} is a research peptide studied in ${researchArea}. ` +
    `${note} ` +
    'Serious research supply is defined by batch-specific testing, clear ' +
    'labeling, and documentation you can verify. ' +
    `${WELLNESS_DISCLAIMER}`
  );
}

// Approved-product catalog. `themeSource` records the original (non-compliant)
// calendar theme so the mapping is auditable, but it is never published.
const PEPTIDE_CATALOG = Object.freeze([
  { slug: 'retatrutide', name: 'Retatrutide', themeSource: 'What is Retatrutide?',
    researchArea: 'metabolic and receptor-signaling research',
    note: 'Investigators study its activity across laboratory models.',
    caption: null },
  { slug: 'klow80', name: 'KLOW80', themeSource: 'The KLOW80 Advantage',
    researchArea: 'peptide-blend and tissue research',
    note: 'A multi-peptide blend examined in controlled laboratory settings.',
    caption: null },
  { slug: 'cjc-1295-ipamorelin', name: 'CJC-1295 / Ipamorelin', themeSource: 'Growth Hormone Optimization',
    researchArea: 'growth-hormone secretagogue research',
    note: 'Studied for its signaling activity in laboratory models.',
    caption: null },
  { slug: 'mots-c', name: 'MOTS-C', themeSource: 'Mitochondrial Health Explained',
    researchArea: 'mitochondrial and cellular-metabolism research',
    note: 'A mitochondrial-derived peptide examined in cell-based studies.',
    caption: null },
  { slug: 'bpc-157-tb-500', name: 'BPC-157 / TB-500', themeSource: 'Healing & Recovery Powerhouse',
    researchArea: 'tissue and cellular-repair research',
    note: 'Two peptides frequently studied together in laboratory models.',
    caption: null },
  { slug: 'nad', name: 'NAD+', themeSource: 'Cellular Energy & Longevity',
    researchArea: 'cellular-metabolism and coenzyme research',
    note: 'A coenzyme widely examined in cellular research.',
    caption: null },
  { slug: 'igf-1-lr3', name: 'IGF-1 LR3', themeSource: 'Muscle Growth & Recovery',
    researchArea: 'growth-factor signaling research',
    note: 'Studied for its receptor activity in laboratory models.',
    caption: null },
  { slug: 'semax', name: 'Semax', themeSource: 'Focus, Mood & Cognitive Support',
    researchArea: 'neuropeptide and cognitive research',
    note: 'A neuropeptide examined in laboratory neuroscience research.',
    caption: null },
  { slug: 'selank', name: 'Selank', themeSource: 'Calm, Focus & Mental Clarity',
    researchArea: 'neuropeptide research',
    note: 'Examined in laboratory models within neuroscience research.',
    caption: null },
  { slug: 'ghk-cu', name: 'GHK-Cu', themeSource: 'Skin Regeneration & Anti-Aging',
    researchArea: 'copper-peptide and skin-tissue research',
    note: 'A copper peptide studied in laboratory tissue research.',
    caption: null },
  { slug: 'kpv', name: 'KPV', themeSource: 'Inflammation Support & Healing',
    researchArea: 'inflammation-pathway research',
    note: 'A tripeptide examined in laboratory inflammation research.',
    caption: null },
  { slug: 'tesamorelin', name: 'Tesamorelin', themeSource: 'Increase Growth Hormone Naturally',
    researchArea: 'growth-hormone-releasing-factor research',
    note: 'Studied for its signaling activity in laboratory models.',
    caption: null },
  { slug: 'kisspeptin-10', name: 'Kisspeptin-10', themeSource: 'Hormone Regulation & Reproductive Health',
    researchArea: 'reproductive-endocrinology research',
    note: 'A signaling peptide examined in laboratory endocrine research.',
    caption: null },
  { slug: 'glutathione', name: 'Glutathione', themeSource: 'Master Antioxidant Protection',
    researchArea: 'antioxidant and cellular research',
    note: 'A tripeptide widely examined in laboratory antioxidant research.',
    caption: null },
  { slug: 'aod-9604', name: 'AOD-9604', themeSource: 'Fat Loss & Metabolic Support',
    researchArea: 'metabolic-research applications',
    note: 'A peptide fragment studied in laboratory metabolic research.',
    caption: null },
  { slug: 'epithalon', name: 'Epithalon', themeSource: 'Telomere Health & Longevity',
    researchArea: 'telomere and cellular-aging research',
    note: 'A tetrapeptide examined in laboratory cellular research.',
    caption: null },
  { slug: 'bpc-157', name: 'BPC-157', themeSource: 'Gut Health & Tissue Repair',
    researchArea: 'gastrointestinal and tissue research',
    note: 'A peptide frequently studied in laboratory tissue research.',
    caption: null },
  { slug: 'tb-500', name: 'TB-500', themeSource: 'Performance & Recovery Booster',
    researchArea: 'tissue-repair and cellular-migration research',
    note: 'A peptide examined in laboratory tissue research.',
    caption: null }
].map((entry, index) => ({
  ...entry,
  caption: caption(entry.name, entry.researchArea, entry.note),
  headline: headlineFor(entry.name),
  // Every peptide gets the brand creative standard (cinematic lion +
  // integrated branded vial + legible layout), with its own flair scene.
  imagePrompt: buildCreativePrompt({
    name: entry.name,
    headline: headlineFor(entry.name),
    pathways: pathwaysFromArea(entry.researchArea),
    flair: flairForIndex(index)
  })
})));

// Products that appeared on the source calendar but are intentionally
// EXCLUDED — off the approved master list; testosterone is a controlled
// substance. Surfaced so the exclusion is explicit, never auto-generated.
const EXCLUDED_PRODUCTS = Object.freeze([
  { name: 'Testosterone Cypionate', reason: 'Controlled substance (Schedule III); not research-use-only; not on the approved product master list.' },
  { name: 'Melanotan II', reason: 'Not on the approved product master list; owner decision required.' },
  { name: 'PT-141', reason: 'Not on the approved product master list; owner decision required.' }
]);

const BY_SLUG = Object.freeze(Object.fromEntries(PEPTIDE_CATALOG.map((p) => [p.slug, p])));

// Deterministically resolve the peptide for a given date, given the series
// start date (day 1). Wraps after the catalog is exhausted so the series
// simply repeats rather than running out.
function peptideForDate(dateStr, startDateStr) {
  const day = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86400000);
  const start = Math.floor(Date.parse(`${startDateStr}T00:00:00Z`) / 86400000);
  if (Number.isNaN(day) || Number.isNaN(start)) throw new Error('Invalid date');
  const index = ((day - start) % PEPTIDE_CATALOG.length + PEPTIDE_CATALOG.length) % PEPTIDE_CATALOG.length;
  return { index, dayNumber: day - start + 1, peptide: PEPTIDE_CATALOG[index] };
}

module.exports = {
  PEPTIDE_CATALOG,
  EXCLUDED_PRODUCTS,
  BY_SLUG,
  peptideForDate
};

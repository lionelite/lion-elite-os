'use strict';

// Who the RUO peptide-supply campaign may contact.
//
// The discovery categories are OSM tags and far too broad: `shop=beauty` covers
// med spas and nail bars equally, and `amenity=clinic` covered an abortion
// provider, a children's hospital wing, an autism therapy practice and a
// university campus centre in the first harvested list. The first group is why
// these tests exist — sending peptide-supply copy there is an incident, not a
// wasted send.

const test = require('node:test');
const assert = require('node:assert/strict');

const { clinicRelevance, TIER_ORDER } = require('../lib/contacts/clinic-targeting');

test('practices this campaign must never contact are excluded', () => {
  // Every one of these was in the first list the exporter produced.
  const mustExclude = [
    { name: 'Preterm', category: 'clinic' },
    { name: 'UH Rainbow Center for Women and Children', category: 'clinic' },
    { name: 'University Hospitals Otis Moss Jr. Health Center', category: 'clinic' },
    { name: 'Childwise ABA', website: 'https://childwiseaba.com/', category: 'clinic' },
    // From the live list on 2026-10-03: tiered medium-fit on a bare
    // `amenity=clinic` tag. Preterm was already excluded by name while the
    // whole category it belongs to was not.
    { name: 'Community Pregnancy Clinics', category: 'clinic' },
    { name: 'Riverside Prenatal & Maternity Center', category: 'clinic' },
    { name: 'MED+ Urgent Care', category: 'clinic' },
    { name: 'Happy Tails Veterinary Clinic', category: 'clinic' },
    { name: 'Bright Smiles Dental', category: 'clinic' }
  ];

  for (const business of mustExclude) {
    const { tier, reasons } = clinicRelevance(business);
    assert.equal(tier, 'exclude', `${business.name} must be excluded`);
    assert.ok(reasons[0], `${business.name} must say why`);
  }
});

test('an institutional domain excludes however good the name looks', () => {
  // "Wellness Center" reads as a perfect target until you see the .edu.
  const { tier, reasons } = clinicRelevance({
    name: 'Wellness Center',
    website: 'http://www.ohiodominican.edu/Campus-Life/Wellness',
    category: 'clinic'
  });

  assert.equal(tier, 'exclude');
  assert.match(reasons[0], /\.edu/);
});

test('beauty trades sharing the shop=beauty tag are excluded', () => {
  for (const name of ['The W Nail Bar', 'Sandy Eyebrows', 'Everglow Nail Salon', 'Milan Laser Hair Removal', 'Palm Beach Tan']) {
    assert.equal(clinicRelevance({ name, category: 'med-spa' }).tier, 'exclude', `${name} is not a clinic`);
  }
});

test('a real aesthetics practice that also waxes is still a clinic', () => {
  // A wrong-trade term only excludes when nothing indicates clinical work.
  const { tier } = clinicRelevance({
    name: 'Miami Beach Laser & Aesthetics',
    website: 'https://miamibeachlaserandaesthetics.com',
    category: 'med-spa'
  });
  assert.equal(tier, 'high');
});

test('injectable, hormone and longevity language tiers high', () => {
  for (const name of [
    'GlowVita MedSpa', 'VIIV Wellness Haus', 'Ageless Hormone & Anti-Aging',
    'Peak Longevity Clinic', 'Riverside IV Infusion Lounge', 'Regenerative Sports Medicine'
  ]) {
    assert.equal(clinicRelevance({ name, category: 'med-spa' }).tier, 'high', `${name} should tier high`);
  }
});

test('the category string is never treated as a name signal', () => {
  // The bug this pins: the OSM category is literally "med-spa", so including it
  // in the searched text made every row in that category match the term
  // "med-spa" and tiered a nail bar as high fit on the strength of its own tag.
  const { tier, signals } = clinicRelevance({ name: 'Babalu', category: 'med-spa' });

  assert.notEqual(tier, 'high', 'a bare name in the med-spa category is not a high-fit signal');
  assert.deepStrictEqual(signals, [], 'the category contributes no name signals');
});

test('medical by tag with an uninformative name is medium, not discarded', () => {
  // A generically-named practice may still be the right target, and a person
  // can tell in one look at the website.
  const { tier, reasons } = clinicRelevance({
    name: 'Dr. Chaurshong Chen, D.O. INC',
    website: 'https://drcschen.com',
    category: 'clinic'
  });

  assert.equal(tier, 'medium');
  assert.match(reasons[0], /check the site/i);
});

test('tier order sorts the best rows to the top', () => {
  assert.ok(TIER_ORDER.high < TIER_ORDER.medium);
  assert.ok(TIER_ORDER.medium < TIER_ORDER.low);
  assert.ok(TIER_ORDER.low < TIER_ORDER.exclude);
});

test('a med spa named only in its domain is still found', () => {
  // Word-boundary matching on the name is right, but a domain concatenates
  // words: "glowvitamedspa.com" has no boundary before "medspa", so boundary
  // matching alone dropped a genuine med spa off the list entirely.
  const { tier, signals } = clinicRelevance({
    name: 'GlowVita',
    website: 'https://glowvitamedspa.com',
    category: 'med-spa'
  });

  assert.equal(tier, 'high');
  assert.ok(signals.includes('medspa'));
});

test('a mid-word coincidence in a name still does not fire', () => {
  // "Titan" must not read as tanning, "Chairs & Co" must not read as hair.
  assert.notEqual(clinicRelevance({ name: 'Titan Strength Co', category: 'med-spa' }).tier, 'exclude');
  assert.notEqual(clinicRelevance({ name: 'Chairs and Co', category: 'med-spa' }).tier, 'exclude');
});

test('occupational and regulatory medicine is not a research-supply target', () => {
  // "The Aviators' Clinic" tiered medium-fit on the live list. A flight
  // physical practice buys nothing a research supplier sells — not a
  // compliance problem like the pregnancy clinics, just a wasted send that
  // drags every downstream rate down.
  for (const name of ["The Aviators' Clinic", 'Metro Occupational Health', 'QuickDOT Physicals']) {
    assert.equal(clinicRelevance({ name, category: 'clinic' }).tier, 'exclude', `${name} is not a buyer`);
  }
});

test('a hormone practice for women is still a target', () => {
  // The pregnancy exclusions must not swallow womens hormone and longevity
  // medicine, which is squarely in this campaign.
  assert.equal(clinicRelevance({ name: "Renew Women's Hormone & Wellness", category: 'clinic' }).tier, 'high');
});

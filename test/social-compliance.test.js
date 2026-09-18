'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateContent, validatePiece, RESEARCH_DISCLAIMER_PHRASE } = require('../lib/social/social-compliance');
const { getBrandProfile, WELLNESS_DISCLAIMER } = require('../lib/social/brand-profiles');

const COMPLIANT_WELLNESS_TEXT =
  `How to read a Certificate of Analysis.\n\n${WELLNESS_DISCLAIMER}`;

test('approves compliant research-education content', () => {
  const result = validateContent({
    text: COMPLIANT_WELLNESS_TEXT,
    complianceMode: 'research-only'
  });
  assert.equal(result.approved, true);
  assert.deepEqual(result.blockers, []);
});

test('the standard wellness disclaimer satisfies the disclaimer requirement without tripping other rules', () => {
  assert.ok(WELLNESS_DISCLAIMER.toLowerCase().includes(RESEARCH_DISCLAIMER_PHRASE));
  const result = validateContent({ text: WELLNESS_DISCLAIMER, complianceMode: 'research-only' });
  assert.equal(result.approved, true);
});

test('blocks dosing language for research-only brands', () => {
  for (const text of [
    `The recommended dose is small.\n\n${WELLNESS_DISCLAIMER}`,
    `Each vial contains 10mg of material.\n\n${WELLNESS_DISCLAIMER}`
  ]) {
    const result = validateContent({ text, complianceMode: 'research-only' });
    assert.equal(result.approved, false);
    assert.ok(result.blockers.some((b) => b.code === 'dosing_language'), text);
  }
});

test('blocks human-use language for research-only brands', () => {
  for (const text of [
    `Here is how to use it before training.\n\n${WELLNESS_DISCLAIMER}`,
    `Reconstitute with bacteriostatic water.\n\n${WELLNESS_DISCLAIMER}`,
    `Plan your protocol carefully.\n\n${WELLNESS_DISCLAIMER}`
  ]) {
    const result = validateContent({ text, complianceMode: 'research-only' });
    assert.equal(result.approved, false);
    assert.ok(result.blockers.some((b) => b.code === 'human_use_language'), text);
  }
});

test('blocks transformation promises for research-only brands', () => {
  const result = validateContent({
    text: `This peptide boosts your metabolism and improves your sleep.\n\n${WELLNESS_DISCLAIMER}`,
    complianceMode: 'research-only'
  });
  assert.equal(result.approved, false);
  assert.ok(result.blockers.some((b) => b.code === 'transformation_promise'));
});

test('blocks medical and treatment claims for every brand', () => {
  for (const mode of ['research-only', 'coaching']) {
    const result = validateContent({
      text: `This is a clinically proven treatment for fatigue.\n\n${WELLNESS_DISCLAIMER}`,
      complianceMode: mode
    });
    assert.equal(result.approved, false, mode);
    assert.ok(result.blockers.some((b) => b.code === 'medical_claim'), mode);
  }
});

test('requires the research disclaimer on research-only content', () => {
  const result = validateContent({
    text: 'A quality note about documentation standards.',
    complianceMode: 'research-only'
  });
  assert.equal(result.approved, false);
  assert.ok(result.blockers.some((b) => b.code === 'missing_research_disclaimer'));
});

test('allows transformation language for coaching brands but blocks guarantees and outcome promises', () => {
  const allowed = validateContent({
    text: 'The transformation is who you become. DM ELITE to start.',
    complianceMode: 'coaching'
  });
  assert.equal(allowed.approved, true);

  const guaranteed = validateContent({
    text: 'Results are guaranteed in our program.',
    complianceMode: 'coaching'
  });
  assert.equal(guaranteed.approved, false);
  assert.ok(guaranteed.blockers.some((b) => b.code === 'guarantee_claim'));

  const outcome = validateContent({
    text: 'Lose 20 lbs with our coaching plan.',
    complianceMode: 'coaching'
  });
  assert.equal(outcome.approved, false);
  assert.ok(outcome.blockers.some((b) => b.code === 'specific_outcome_promise'));
});

test('keeps research-product language out of the coaching brand', () => {
  const result = validateContent({
    text: 'Ask us about peptides and the research catalog.',
    complianceMode: 'coaching'
  });
  assert.equal(result.approved, false);
  assert.ok(result.blockers.some((b) => b.code === 'brand_separation'));
});

test('fails closed on empty text and unknown compliance modes', () => {
  assert.equal(validateContent({ text: '', complianceMode: 'coaching' }).approved, false);
  const unknown = validateContent({ text: 'Hello world.', complianceMode: 'other' });
  assert.equal(unknown.approved, false);
  assert.ok(unknown.blockers.some((b) => b.code === 'unknown_compliance_mode'));
});

test('validatePiece reports per-platform results and overall approval', () => {
  const profile = getBrandProfile('wellness');
  const piece = {
    slot: 'feed',
    platforms: {
      instagram: { text: COMPLIANT_WELLNESS_TEXT },
      x: { text: 'Take this daily for gains.' }
    }
  };
  const result = validatePiece(piece, profile);
  assert.equal(result.approved, false);
  assert.equal(result.platforms.instagram.approved, true);
  assert.equal(result.platforms.x.approved, false);
});

// --- clinical-supply mode --------------------------------------------------
//
// A bulk drug substance sold to a 503A pharmacy or 503B outsourcing facility.
// This mode is an inversion of research-only, not a relaxation of it, so the
// tests that matter are the ones proving the two cannot be swapped.

const { CLINICAL_SUPPLY_AUDIENCE_PHRASE } = require('../lib/social/social-compliance');

const supply = text => validateContent({ text, complianceMode: 'clinical-supply' });
const codes = outcome => outcome.blockers.map(blocker => blocker.code);
const withAudience = text => `${text} Supplied to ${CLINICAL_SUPPLY_AUDIENCE_PHRASE} only.`;

test('clinical-supply copy must state its audience restriction', () => {
  assert.deepEqual(codes(supply('Bulk substance available now.')), ['missing_audience_restriction']);
  assert.equal(supply(withAudience('Bulk substance available now.')).approved, true);
});

test('research-use-only language is BLOCKED in clinical supply, not required', () => {
  // The exact inversion of research-only mode: material sold to be compounded
  // into a human medicine cannot also be labelled not-for-human-use.
  assert.ok(codes(supply(withAudience('Research use only material.'))).includes('research_use_language'));
  assert.ok(codes(supply(withAudience('This is research-grade product.'))).includes('research_use_language'));

  // ...and the same sentence is exactly what research-only mode requires.
  const researchText = 'Supplied for laboratory research purposes only.';
  assert.equal(validateContent({ text: researchText, complianceMode: 'research-only' }).approved, true);
  assert.ok(codes(supply(researchText)).includes('research_use_language'));
});

test('a bare specification quantity is legitimate here, unlike in research mode', () => {
  const spec = withAudience('Retatrutide, 30 mg vial. Net content 31.30 mg, purity 99.99% by HPLC-UV.');
  assert.equal(supply(spec).approved, true, codes(supply(spec)).join(', '));
  // The same quantity is a blocker under research-only rules.
  assert.ok(validateContent({ text: spec, complianceMode: 'research-only' }).blockers.length > 0);
});

test('directing clinical use is refused — that is the prescriber\'s role, not the supplier\'s', () => {
  for (const text of [
    'Starting dose is 2 mg per week.',
    'Reconstitute with bacteriostatic water before use.',
    'Administer subcutaneously.',
    'How to administer this product.'
  ]) {
    assert.ok(codes(supply(withAudience(text))).includes('dosing_or_administration_guidance'), text);
  }
});

test('compounding eligibility is a counsel determination, never a marketing sentence', () => {
  for (const text of ['Approved for compounding.', 'On the 503B bulks list.', 'Fully 503A-compliant.']) {
    assert.ok(codes(supply(withAudience(text))).includes('unsubstantiated_eligibility_claim'), text);
  }
});

test('an FDA registration is not an approval, but a registered facility is a fact', () => {
  assert.ok(codes(supply(withAudience('An FDA-registered product.'))).includes('fda_endorsement_implication'));
  assert.ok(codes(supply(withAudience('Approved by the FDA.'))).includes('fda_endorsement_implication'));
  // Factual and allowed: the registration belongs to the facility.
  assert.equal(supply(withAudience('Sourced from an FDA-registered facility in the US.')).approved, true);
});

test('patient-directed copy is refused in a channel that sells to licensed buyers', () => {
  for (const text of ['Transform your body.', "You'll feel amazing.", 'Lose weight fast.']) {
    assert.ok(codes(supply(withAudience(text))).length > 0, text);
  }
});

test('shared rules still apply in clinical supply', () => {
  assert.ok(codes(supply(withAudience('Clinically proven and FDA-approved.'))).includes('medical_claim'));
  assert.ok(codes(supply(withAudience('Results guaranteed.'))).includes('guarantee_claim'));
});

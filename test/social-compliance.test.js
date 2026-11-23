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

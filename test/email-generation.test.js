'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEmail, scoreEmail, selectOffer } = require('../lib/email-generation');

test('generates a personalized email with verified business context and phone signature', () => {
  const draft = buildEmail({
    businessName: 'Legacy Fit',
    contactName: 'Manning',
    category: 'Personal training and bootcamp',
    location: 'Miami, FL',
    partnershipAngle: 'affiliate and transformation coaching partnership',
    goal: 'helping members sustain progress beyond the initial transformation phase',
    specificOpportunity: 'give members a high-touch accountability option between training sessions',
    verifiedFacts: [
      { status: 'verified', text: 'Legacy Fit operates multiple South Florida locations' }
    ]
  });

  assert.equal(draft.approved, true);
  assert.match(draft.subject, /Legacy Fit|partnership/i);
  assert.match(draft.body, /multiple South Florida locations/i);
  assert.match(draft.body, /high-touch accountability option/i);
  assert.match(draft.body, /216-326-0050/);
  assert.match(draft.body, /lionelitebeauty\.com/i);
  assert.ok(draft.quality.score >= 56.25);
});

test('uses a team greeting when a decision maker is not verified', () => {
  const draft = buildEmail({
    businessName: "Dane's Body Shop",
    category: 'Independent fitness studio',
    location: 'Austin, TX',
    partnershipAngle: 'referral partnership'
  });

  assert.match(draft.body, /Hi Dane's Body Shop team,/);
  assert.doesNotMatch(draft.body, /Hi undefined/);
});

test('selects the relevant offer from the campaign angle', () => {
  assert.equal(selectOffer({ partnershipAngle: 'content collaboration' }).key, 'content');
  assert.equal(selectOffer({ partnershipAngle: 'affiliate opportunity' }).key, 'affiliate');
  assert.equal(selectOffer({ partnershipAngle: 'member referrals' }).key, 'referral');
});

test('blocks drafts containing prohibited claims', () => {
  const draft = buildEmail({
    businessName: 'Example Wellness',
    category: 'Wellness studio',
    proof: 'We guarantee results for every client.'
  });

  assert.equal(draft.approved, false);
  assert.ok(draft.quality.blockers.includes('prohibited_claim'));
});

test('quality scorer blocks missing phone signatures', () => {
  const quality = scoreEmail({
    subject: 'Partnership idea',
    body: 'Hi team,\n\nThis is a useful idea.\n\nWould you be open to talking?\n\nBest,\nAlexander'
  }, { businessName: 'Example Gym' });

  assert.ok(quality.blockers.includes('missing_phone_signature'));
  assert.equal(quality.dimensions.signature, 0);
});

test('requires a business name', () => {
  assert.throws(() => buildEmail({ category: 'Fitness studio' }), /businessName is required/);
});

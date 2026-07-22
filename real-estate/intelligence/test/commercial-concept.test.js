'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreLocation, analyzeCompetitors, suburbInfo, CONCEPT } = require('../src/commercial-concept');

test('suburbInfo recognizes affluent target suburbs and tiers', () => {
  assert.equal(suburbInfo('Pepper Pike, OH').tier, 1);
  assert.equal(suburbInfo('Shaker Heights').tier, 2);
  assert.equal(suburbInfo('Parma'), null);
});

test('scoreLocation prefers verified income, then suburb tier', () => {
  const withIncome = scoreLocation({ suburb: 'Beachwood', medianHouseholdIncome: 130000, sqft: 4000, parkingSpaces: 20, retailCoTenancy: true, zonedForMedical: true });
  assert.ok(withIncome.dimensions.demographics >= 70);
  const tierOnly = scoreLocation({ suburb: 'Pepper Pike' });
  assert.equal(tierOnly.dimensions.demographics, 90);
  const offTarget = scoreLocation({ suburb: 'Parma' });
  assert.equal(offTarget.dimensions.demographics, 40);
});

test('a strong tier-1 site with room and parking recommends PURSUE', () => {
  const s = scoreLocation({ suburb: 'Pepper Pike', sqft: 4200, parkingSpaces: 24, retailCoTenancy: true, visibility: 80, zonedForMedical: true, competitorsWithin3mi: 2 });
  assert.equal(s.recommendation, 'PURSUE');
  assert.ok(s.overall >= 75);
});

test('gap analysis flags the luxury and integrated-concept white space', () => {
  const competitors = [
    { name: 'A', type: 'medspa', tier: 'mid', membership: false, services: ['botox', 'fillers'] },
    { name: 'B', type: 'pilates', tier: 'upscale', membership: true, services: ['reformer pilates'] },
    { name: 'C', type: 'pilates', tier: 'mid', membership: true, services: ['reformer pilates'] }
  ];
  const gap = analyzeCompetitors(competitors);
  assert.equal(gap.tierCounts.luxury, 0);
  assert.equal(gap.combinedConceptCount, 0);
  assert.ok(gap.whiteSpace.some((w) => /LUXURY/.test(w)));
  assert.ok(gap.whiteSpace.some((w) => /under one roof/.test(w)));
});

test('gap analysis detects when a combined concept already exists', () => {
  const competitors = [
    { name: 'Combo', type: 'medspa', tier: 'luxury', membership: true, services: ['botox', 'reformer pilates', 'cold plunge'] }
  ];
  const gap = analyzeCompetitors(competitors);
  assert.equal(gap.combinedConceptCount, 1);
  assert.equal(gap.tierCounts.luxury, 1);
  assert.equal(gap.whiteSpace.some((w) => /LUXURY/.test(w)), false);
});

test('concept exposes its pillars and differentiator', () => {
  assert.ok(CONCEPT.pillars.includes('reformer_pilates'));
  assert.ok(CONCEPT.pillars.includes('med_spa_aesthetics'));
  assert.match(CONCEPT.differentiator, /single-service/);
});

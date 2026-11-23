'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateMonthlyPITI, selfSufficiencyTest, houseHackPosition, distressScore,
  fhaDealKillers, assessFhaHouseHack, filterFhaCandidates, DEFAULT_CONFIG
} = require('../src/fha-househack');

// A strong Cleveland fourplex prototype.
const CLE_FOURPLEX = {
  id: 'cle-1', address: '1234 W 65th St, Cleveland, OH', market: 'Cleveland', county: 'Cuyahoga',
  units: 4, askingPrice: 320000, unitRents: [1100, 1050, 1000, 950],
  estimatedRepairs: 30000, estimatedAfterRepairValue: 430000,
  hasVacancy: true, openCodeViolations: 2, absenteeOwner: true, taxDelinquent: true,
  ownerOccupiable: true, habitableOrFinanceable: true,
  monthlyGrossRent: 4100, annualOperatingExpenses: 16000, annualDebtService: 22000,
  motivationScore: 80, equityScore: 70, physicalConditionScore: 55, legalRiskScore: 70,
  marketScore: 65, dataConfidenceScore: 60
};

test('PITI estimate is a positive monthly number scaling with price', () => {
  const low = estimateMonthlyPITI(200000);
  const high = estimateMonthlyPITI(400000);
  assert.ok(low > 0 && high > low);
});

test('Self-Sufficiency Test applies to 3-4 units and exempts 1-2', () => {
  const four = selfSufficiencyTest(CLE_FOURPLEX);
  assert.equal(four.applies, true);
  // 75% of $4100 = $3075 must cover PITI on $320k (~$2,300-2,600). Passes.
  assert.equal(four.passes, true);
  assert.ok(four.netRentalIncome > four.piti);

  const duplex = selfSufficiencyTest({ units: 2, askingPrice: 300000, monthlyGrossRent: 1200 });
  assert.equal(duplex.applies, false);
  assert.equal(duplex.passes, true); // exempt
});

test('Self-Sufficiency Test fails a thin 3-4 unit deal', () => {
  const thin = selfSufficiencyTest({ units: 4, askingPrice: 500000, monthlyGrossRent: 2800 });
  assert.equal(thin.applies, true);
  assert.equal(thin.passes, false); // 0.75*2800=2100 < PITI on $500k
});

test('house-hack position shows owner living cheap when rent covers the note', () => {
  const pos = houseHackPosition(CLE_FOURPLEX);
  assert.ok(pos.otherUnitsRent > 0);
  // 3 lower units (1000+1050+950=3000) vs PITI ~2400 → lives for free.
  assert.equal(pos.livesForFree, true);
  assert.ok(pos.ownerNetHousingCost < 0);
});

test('distress score rewards the target signals', () => {
  const d = distressScore(CLE_FOURPLEX);
  assert.ok(d.signals.includes('vacancy'));
  assert.ok(d.signals.includes('code_violations'));
  assert.ok(d.signals.includes('tax_distress'));
  assert.ok(d.signals.includes('absentee_owner'));
  assert.ok(d.score >= 60);
});

test('deal-killers catch out-of-range units, over-limit loan, and no owner unit', () => {
  assert.ok(fhaDealKillers({ units: 6, askingPrice: 300000 }).some((k) => /outside FHA house-hack range/.test(k)));
  assert.ok(fhaDealKillers({ units: 4, askingPrice: 1200000, monthlyGrossRent: 9000 }).some((k) => /exceeds FHA/.test(k)));
  assert.ok(fhaDealKillers({ units: 4, askingPrice: 300000, ownerOccupiable: false, monthlyGrossRent: 4100 }).some((k) => /owner-occupiable/.test(k)));
});

test('condition gate allows a 203(k) rehab candidate but blocks an unfinanceable one', () => {
  const base = { units: 3, askingPrice: 250000, monthlyGrossRent: 3000, ownerOccupiable: true };
  assert.ok(fhaDealKillers({ ...base, habitableOrFinanceable: false }).some((k) => /203\(k\)/.test(k)));
  assert.equal(fhaDealKillers({ ...base, habitableOrFinanceable: false, fha203kCandidate: true }).some((k) => /203\(k\)/.test(k)), false);
});

test('assessment recommends PURSUE for a strong compliant fourplex', () => {
  const a = assessFhaHouseHack(CLE_FOURPLEX);
  assert.equal(a.strategy, 'fha-househack');
  assert.equal(a.fhaDealKillers.length, 0);
  assert.equal(a.recommendation, 'PURSUE');
  assert.ok(a.fitScore >= 72);
  assert.ok(a.disclaimers.some((d) => /underwriting/.test(d)));
});

test('filter narrows to in-market 2-4 units and ranks by fit', () => {
  const properties = [
    CLE_FOURPLEX,
    { id: 'miami', address: 'Miami, FL', market: 'Miami', units: 4, askingPrice: 600000, monthlyGrossRent: 8000 },
    { id: 'cle-single', address: 'Cleveland, OH', market: 'Cleveland', units: 1, askingPrice: 150000 },
    { id: 'cle-duplex', address: 'Cleveland, OH', market: 'Cleveland', units: 2, askingPrice: 180000, unitRents: [900, 850], ownerOccupiable: true, habitableOrFinanceable: true }
  ];
  const { candidates, excluded } = filterFhaCandidates(properties);
  const ids = candidates.map((c) => c.propertyId);
  assert.ok(ids.includes('cle-1'));
  assert.ok(ids.includes('cle-duplex'));
  assert.equal(ids.includes('miami'), false);      // out of market
  assert.equal(ids.includes('cle-single'), false); // 1 unit
  assert.ok(excluded.some((e) => e.reason === 'out_of_market'));
  assert.ok(excluded.some((e) => e.reason === 'units_1'));
  // Fourplex outranks duplex.
  assert.equal(candidates[0].propertyId, 'cle-1');
});

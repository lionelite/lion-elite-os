'use strict';

// Demo: run the Cleveland FHA house-hack profile over sample properties.
//   node real-estate/intelligence/src/fha-demo.js
// Demo data only — wire filterFhaCandidates() to a real Cleveland MLS /
// distressed-lead feed to use it for live sourcing.

const { filterFhaCandidates } = require('./fha-househack');

const SAMPLE = [
  { id: 'cle-fourplex', address: '1234 W 65th St, Cleveland, OH', market: 'Cleveland',
    units: 4, askingPrice: 320000, unitRents: [1100, 1050, 1000, 950],
    estimatedRepairs: 30000, estimatedAfterRepairValue: 430000,
    hasVacancy: true, openCodeViolations: 2, absenteeOwner: true, taxDelinquent: true,
    ownerOccupiable: true, habitableOrFinanceable: true, monthlyGrossRent: 4100 },
  { id: 'cle-triplex', address: '5678 Detroit Ave, Cleveland, OH', market: 'Cleveland',
    units: 3, askingPrice: 245000, unitRents: [1000, 950, 900],
    estimatedRepairs: 15000, estimatedAfterRepairValue: 300000,
    preForeclosure: true, absenteeOwner: true, ownerOccupiable: true, habitableOrFinanceable: true,
    monthlyGrossRent: 2850 },
  { id: 'cle-thin-triplex', address: '99 Overpriced Rd, Cleveland, OH', market: 'Cleveland',
    units: 3, askingPrice: 470000, unitRents: [1000, 950, 900], ownerOccupiable: true,
    habitableOrFinanceable: true, monthlyGrossRent: 2850 },
  { id: 'miami-fourplex', address: 'Little Havana, Miami, FL', market: 'Miami',
    units: 4, askingPrice: 750000, monthlyGrossRent: 9000 },
  { id: 'cle-single', address: 'Single family, Cleveland, OH', market: 'Cleveland', units: 1, askingPrice: 160000 }
];

const { candidates, excluded } = filterFhaCandidates(SAMPLE);

console.log('Cleveland FHA house-hack candidates (ranked):\n');
for (const c of candidates) {
  console.log(`${c.recommendation.padEnd(7)} fit ${c.fitScore}  ${c.units}u  ${c.address}`);
  console.log(`   self-sufficiency: ${c.selfSufficiency.passes ? 'PASS' : 'FAIL'} (margin $${c.selfSufficiency.marginMonthly}/mo) · owner housing cost $${c.houseHack.ownerNetHousingCost}/mo · equity ${c.equity.spreadPct}%`);
  if (c.fhaDealKillers.length) console.log(`   deal-killers: ${c.fhaDealKillers.join('; ')}`);
}
console.log(`\nExcluded (${excluded.length}): ${excluded.map((e) => `${e.id} [${e.reason}]`).join(', ')}`);

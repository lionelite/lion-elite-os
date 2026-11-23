'use strict';

// Demo: score sample sites and run the competitor gap analysis for the
// med-spa + Pilates luxury concept.  node real-estate/intelligence/src/concept-demo.js

const path = require('path');
const fs = require('fs');
const { CONCEPT, scoreLocation, analyzeCompetitors } = require('./commercial-concept');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cleveland-competitors.seed.json'), 'utf8'));

const SITES = [
  { suburb: 'Pepper Pike', sqft: 4200, parkingSpaces: 24, retailCoTenancy: true, visibility: 78, zonedForMedical: true, competitorsWithin3mi: 2 },
  { suburb: 'Beachwood', sqft: 3800, parkingSpaces: 30, retailCoTenancy: true, visibility: 88, zonedForMedical: true, competitorsWithin3mi: 5 },
  { suburb: 'Chagrin Falls', sqft: 2600, parkingSpaces: 12, retailCoTenancy: true, visibility: 70, zonedForMedical: false, competitorsWithin3mi: 3 },
  { suburb: 'Parma', sqft: 3000, parkingSpaces: 20, retailCoTenancy: false, visibility: 60, zonedForMedical: true, competitorsWithin3mi: 1 }
];

console.log(`${CONCEPT.name}\nPositioning: ${CONCEPT.positioning}\n`);

console.log('Candidate sites (ranked):');
for (const s of SITES.map((x) => scoreLocation(x, seed.competitors)).sort((a, b) => b.overall - a.overall)) {
  console.log(`  ${s.recommendation.padEnd(7)} ${s.overall}  ${s.location} (tier ${s.affluenceTier ?? '—'}) · demo ${s.dimensions.demographics} comp ${s.dimensions.competition} site ${s.dimensions.site}`);
}

const gap = analyzeCompetitors(seed.competitors);
console.log(`\nCompetitor landscape (${gap.total} seed competitors):`);
console.log('  by type:', JSON.stringify(gap.byType), '· tiers:', JSON.stringify(gap.tierCounts));
console.log('  membership share:', gap.membershipShare, '· combined medspa+pilates operators:', gap.combinedConceptCount);
console.log('\nWhite space:');
for (const w of gap.whiteSpace) console.log('  •', w);

#!/usr/bin/env node
'use strict';

// Swipe intelligence report: load the database, show winners, extract the
// patterns they share, and print candidate SOPs to test at Lion Elite.
//
//   npm run swipe:report
//
// Everything printed is directional evidence. A candidate becomes a permanent
// SOP only after our own results validate it (see sop-ledger.js).

const { load } = require('./swipe-database');
const { extractPatterns, proposeCandidates } = require('./pattern-extraction');

function fmtMetric(m) {
  const arrow = m.direction === 'decrease' ? '▼' : '▲';
  return `${arrow} ${m.name} ${m.value}${m.unit || ''}`;
}

function main() {
  const { entries, winners, invalid, warnings } = load();

  console.log('=== Lion Elite — Swipe Intelligence ===\n');
  console.log(`Entries: ${entries.length} valid, ${winners.length} winners, ${invalid.length} invalid.`);
  if (invalid.length) {
    for (const bad of invalid) console.log(`  ✗ ${bad.id}: ${bad.errors.join('; ')}`);
  }
  console.log('');

  console.log('--- Winners (reported by source, not independently verified) ---');
  for (const w of winners) {
    const metrics = (w.performance.metrics || []).map(fmtMetric).join('  ');
    console.log(`  • ${w.brand} [${w.industry}] — ${metrics}  (src: ${w.source.name})`);
  }
  console.log('');

  const patterns = extractPatterns(winners);
  console.log('--- Shared patterns among winners ---');
  if (patterns.lowSample) console.log(`  ⚠ Small sample (n=${patterns.sampleSize}): treat as hypotheses, not laws.`);
  console.log(`  Ad + landing page as ONE system: ${patterns.adLandingSystem.support}/${patterns.sampleSize} winners (${patterns.adLandingSystem.brands.join(', ') || 'none'})`);
  console.log('  Top levers/tactics:');
  for (const lever of patterns.allLevers.slice(0, 8)) {
    console.log(`    - ${lever.value}: ${lever.support}/${patterns.sampleSize} (${Math.round(lever.share * 100)}%)`);
  }
  if (patterns.formats.length) {
    console.log('  Creative formats:');
    for (const f of patterns.formats) console.log(`    - ${f.value}: ${f.support}`);
  }
  console.log('');

  console.log('--- Candidate SOPs to TEST (not copy) ---');
  const candidates = proposeCandidates(patterns, winners);
  for (const c of candidates) {
    console.log(`  □ ${c.statement}`);
    console.log(`      evidence: ${c.evidence.join(', ')}`);
  }
  console.log('');

  const gapCount = warnings.length;
  console.log(`--- Research gaps: ${gapCount} entr${gapCount === 1 ? 'y' : 'ies'} still incomplete ---`);
  for (const w of warnings) {
    console.log(`  ${w.id}: ${w.warnings.join('; ')}`);
  }
  console.log('\nFill gaps by inspecting the actual ads/landing pages, then re-run.');
}

if (require.main === module) main();

module.exports = { main };

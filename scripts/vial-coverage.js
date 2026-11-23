#!/usr/bin/env node
'use strict';

// Vial library coverage report. Lists every product the marketing pipeline
// knows about (approved peptide catalog + manifest extras) and whether its
// real vial image is present at content/media/vials/<slug>.png.
//
//   npm run social:vials
//
// Use it while building out the vial library — anything under "MISSING"
// still falls back to an AI-rendered vial until a real asset is dropped in.

const { coverage } = require('../lib/social/vial-registry');

function main() {
  const report = coverage();
  console.log(`Vial library coverage: ${report.provided}/${report.total} products have a real vial asset.\n`);
  for (const p of report.products) {
    const mark = p.provided ? '✓' : '·';
    const state = p.provided ? 'real vial' : 'MISSING — AI fallback';
    console.log(`  ${mark} ${p.name.padEnd(24)} ${state.padEnd(22)} ${p.file}`);
  }
  if (report.missing.length) {
    console.log(`\nDrop transparent-background PNGs for the ${report.missing.length} missing product(s):`);
    console.log(`  ${report.missing.map((s) => `content/media/vials/${s}.png`).join('\n  ')}`);
  } else {
    console.log('\nEvery product has a real vial asset. 🎉');
  }
}

main();

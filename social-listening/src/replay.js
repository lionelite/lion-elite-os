#!/usr/bin/env node
'use strict';

// Offline replay harness: runs sample posts through the exact classify →
// refine → surface path the live monitor uses, so the pipeline can be
// demonstrated and tuned without network access. Add cases to the array
// or pass a JSON file of strings: node social-listening/src/replay.js [file.json]

const fs = require('fs');
const { classifyPost } = require('./classifier');

const SAMPLE_POSTS = [
  'Any recommendations for a reliable peptide supplier with actual COA documentation? Our lab needs a new BPC-157 source for an in vitro study.',
  'Where do you all buy research peptides? Looking for a legit vendor with third party tested purity.',
  'Looking to buy BPC-157, starting my cycle next week — what dose did you inject?',
  'FDA cracks down on gray-market peptides, story at 9.',
  'New year new me. Seriously thinking about hiring a personal trainer, any recommendations? Total beginner, no idea where to start.',
  'Finally want to get in shape but gyms are overwhelming. Is an online coach worth it?',
  "I'm a certified personal trainer accepting new clients — DM me to start!",
  'Crushed my workout routine today, gym was empty.',
  'Looking for recommendations on a good espresso machine.'
];

const posts = process.argv[2]
  ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  : SAMPLE_POSTS;

for (const text of posts) {
  const { relevant, matches } = classifyPost(text);
  console.log(`\nPOST: ${text}`);
  if (!relevant) {
    console.log('  → no match (not surfaced)');
    continue;
  }
  for (const match of matches) {
    console.log(`  → ${match.audience} score=${match.score}${match.doNotEngage ? ' ⛔ DO NOT ENGAGE' : ''}`);
    console.log(`    subject=[${match.matched.subject.join(', ')}] intent=[${match.matched.intent.join(', ')}] booster=[${match.matched.booster.join(', ')}]`);
    if (match.doNotEngage) console.log(`    reason: ${match.doNotEngageReason}`);
    else console.log(`    suggested opener (manual use only): ${match.suggestedOpener}`);
  }
}

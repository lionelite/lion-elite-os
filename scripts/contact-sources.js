#!/usr/bin/env node
'use strict';

// What routes exist for getting contact information, which are producing, and
// what each dormant one is waiting on.
//
//   npm run contacts:sources
//
// Reads the declarative manifest. No database, no network, no credentials.

const {
  CONTACT_SOURCES, REFUSED_SOURCES, liveSources, dormantSources, sourcesYielding
} = require('../lib/contacts/source-manifest');

const pad = (value, width) => String(value).padEnd(width);

function main() {
  const sources = Object.values(CONTACT_SOURCES);

  console.log('\nCONTACT ACQUISITION — how information enters the pipeline\n');
  console.log(pad('SOURCE', 26) + pad('STATUS', 9) + pad('COST/REC', 10) + 'YIELDS');
  console.log('-'.repeat(100));
  for (const source of sources) {
    const cost = source.costPerRecord === 0 ? 'free' : `$${source.costPerRecord.toFixed(3)}`;
    console.log(pad(source.id, 26) + pad(source.status, 9) + pad(cost, 10) + source.yields.join(', '));
  }

  console.log(`\nPRODUCING TODAY (${liveSources().length} of ${sources.length})`);
  for (const source of liveSources()) {
    console.log(`  ${pad(source.id, 26)} ${source.legalBasis}`);
  }

  // The number that matters. This repo's recurring failure is code that is
  // complete, tested and wired to nothing, so what each dormant route is
  // waiting on is a truer status than a module count.
  console.log('\nBUILT BUT NOT PRODUCING — and what each needs');
  for (const entry of dormantSources()) {
    console.log(`  ${pad(entry.id, 26)} ${pad('[' + entry.status + ']', 10)} ${entry.waitingOn}`);
  }

  console.log('\nWHERE CONTACT DETAILS ACTUALLY COME FROM');
  for (const field of ['work_email', 'company_general_email', 'company_phone']) {
    const routes = sourcesYielding(field).map(s => `${s.id} (${s.status})`);
    console.log(`  ${pad(field, 26)} ${routes.length ? routes.join(', ') : 'no route'}`);
  }

  console.log('\nNOT AVAILABLE, AND WHY');
  for (const refusal of Object.values(REFUSED_SOURCES)) {
    console.log(`  ${refusal.id}`);
    console.log(`    ${refusal.reason}`);
    console.log(`    use instead: ${refusal.alternative}\n`);
  }

  console.log('Every route admits records through lib/contacts/acquisition.js acquire(),');
  console.log('which attaches provenance and refuses anything outside the B2B authorization.');
  console.log('Nothing here sends. Enabling a send path is a separate, human action.\n');
}

if (require.main === module) main();
module.exports = { main };

#!/usr/bin/env node
'use strict';

// Export a SANITIZED aggregate leads summary (no names/emails) to files
// that can be uploaded as a CI artifact and analyzed.
//
//   node scripts/leads-export.js [--out=leads-export]
//
// Requires DATABASE_URL. Writes <out>.json and <out>.md. Fails clearly if
// the database is not configured/reachable — it never fabricates data.

const fs = require('fs');

function parseArgs(argv) {
  const args = { out: 'leads-export', full: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--full') args.full = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) {
    console.error('[leads-export] DATABASE_URL is not set — nothing to export. Add it as a secret and re-run.');
    process.exitCode = 1;
    return;
  }

  // --full includes names + emails. HARD BOUNDARY: never inside GitHub
  // Actions — this repo is public and full third-party PII must not be
  // written to a CI artifact. Full detail is a LOCAL/private-run only.
  if (args.full && String(process.env.GITHUB_ACTIONS).toLowerCase() === 'true') {
    console.error('[leads-export] Refusing --full inside GitHub Actions: full names/emails must not be written to CI artifacts on a public repo. Run it locally (or against a private replica) instead.');
    process.exitCode = 1;
    return;
  }

  const { buildLeadsDigest } = require('../lib/leads-digest');
  const { sanitizeDigest, renderSummaryMarkdown, renderFullMarkdown } = require('../lib/leads-export');

  const digest = await buildLeadsDigest();

  if (args.full) {
    fs.writeFileSync(`${args.out}.json`, `${JSON.stringify(digest, null, 2)}\n`);
    fs.writeFileSync(`${args.out}.md`, `${renderFullMarkdown(digest)}\n`);
    console.log(`[leads-export] Wrote ${args.out}.json and ${args.out}.md (FULL — names + emails, ${digest.prospects.total} prospects). Keep these files local; do not commit or upload.`);
    return;
  }

  const sanitized = sanitizeDigest(digest);
  fs.writeFileSync(`${args.out}.json`, `${JSON.stringify(sanitized, null, 2)}\n`);
  fs.writeFileSync(`${args.out}.md`, `${renderSummaryMarkdown(sanitized)}\n`);
  console.log(`[leads-export] Wrote ${args.out}.json and ${args.out}.md (sanitized, ${sanitized.prospects.total} prospects).`);
}

main()
  .catch((error) => {
    console.error(`[leads-export] FATAL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await require('../lib/database').close(); } catch { /* no pool */ }
  });

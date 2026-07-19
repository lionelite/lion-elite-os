#!/usr/bin/env node
'use strict';

// Publish the day's generated + compliance-validated content to our own
// brand accounts (Issue #48 Phase 2). Reads the committed
// content/generated/<date>/social-content.json, publishes to whichever
// platforms have credentials, and writes an idempotent publish log so a
// rerun never double-posts.
//
//   node scripts/publish-social-content.js [--date=YYYY-MM-DD] [--dry-run]
//
// Fail-closed: does nothing unless SOCIAL_PUBLISH_ENABLED=true.

const fs = require('fs');
const path = require('path');
const { publishAll, isPublishingEnabled, selectPublishTargets } = require('../lib/social/publish-orchestrator');

const REPO_ROOT = path.join(__dirname, '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'content', 'generated');

function parseArgs(argv) {
  const args = { date: new Date().toISOString().slice(0, 10), dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--date=')) args.date = arg.slice('--date='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date: ${args.date}`);
  return args;
}

function writeGithubOutput(values) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  fs.appendFileSync(outputFile, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const dayDir = path.join(GENERATED_DIR, args.date);
  const contentFile = path.join(dayDir, 'social-content.json');
  if (!fs.existsSync(contentFile)) {
    throw new Error(`No generated content for ${args.date} (${path.relative(REPO_ROOT, contentFile)} missing). Run generation first.`);
  }
  const payload = JSON.parse(fs.readFileSync(contentFile, 'utf8'));

  const logFile = path.join(dayDir, 'publish-log.json');
  const publishLog = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : { date: args.date, results: [] };

  if (args.dryRun) {
    const targets = selectPublishTargets(payload);
    console.log(`[publish] Dry run for ${args.date}. Publishing ${isPublishingEnabled() ? 'ENABLED' : 'disabled'}.`);
    console.log(`[publish] ${targets.length} platform target(s) with credentials:`);
    for (const t of targets) console.log(`  - ${t.piece.id} → ${t.platform}`);
    writeGithubOutput({ published: 0, failed: 0, targets: targets.length });
    return;
  }

  const result = await publishAll({ payload, publishLog });
  const updated = { date: args.date, updatedAt: new Date().toISOString(), results: result.results };
  fs.writeFileSync(logFile, `${JSON.stringify(updated, null, 2)}\n`);

  console.log(`[publish] ${args.date}: published=${result.published} failed=${result.failed}${result.skipped ? ' (disabled)' : ''}`);
  writeGithubOutput({ published: result.published, failed: result.failed });
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[publish] FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});

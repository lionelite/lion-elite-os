#!/usr/bin/env node
'use strict';

// Ingest a provided image into Lion Elite's controlled public media store
// and print its stable HTTPS URL. This closes the first hop of the
// pipeline the content docs call out as the bottleneck:
//
//   image file  →  content/media/<date>/<id>.jpg (committed to the
//   automation/social-content branch)  →  stable raw.githubusercontent.com
//   URL  →  Metricool "Picture Url 1" / Instagram/Facebook publisher
//
//   node scripts/host-media.js --file=./retatrutide.jpg --date=2026-07-19 --id=2026-07-19-wellness-feed
//   node scripts/host-media.js --file=./photo.jpg --id=lew-retatrutide   # date defaults to today
//
// After running, commit content/ to the automation branch (the daily
// workflow does this automatically) and the URL goes live.

const fs = require('fs');
const path = require('path');
const { mediaRelativePath, mediaUrlFor } = require('../lib/social/media-hosting');

const REPO_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { file: null, date: new Date().toISOString().slice(0, 10), id: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
    else if (arg.startsWith('--date=')) args.date = arg.slice('--date='.length);
    else if (arg.startsWith('--id=')) args.id = arg.slice('--id='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.file) throw new Error('--file=<path to image> is required');
  if (!args.id) throw new Error('--id=<piece id or slug> is required (e.g. 2026-07-19-wellness-feed)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date: ${args.date}`);
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.file)) throw new Error(`File not found: ${args.file}`);

  const ext = path.extname(args.file).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg') {
    // Instagram's publishing API rejects non-JPEG; warn loudly but still
    // host it (Facebook/X/Bluesky/Metricool accept it), so the operator can
    // decide. We don't ship an image-conversion dependency.
    console.warn(`[host] WARNING: ${ext || 'no extension'} is not JPEG. Instagram will reject it — convert to .jpg for IG. Hosting anyway.`);
  }

  const piece = { id: args.id, date: args.date };
  const rel = mediaRelativePath(piece);
  const abs = path.join(REPO_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(args.file, abs);

  const url = mediaUrlFor(piece);
  console.log(`[host] stored ${args.file} → ${rel}`);
  console.log(`[host] stable URL: ${url}`);
  console.log('[host] Commit content/ to the automation/social-content branch to make the URL live.');
}

try {
  main();
} catch (error) {
  console.error(`[host] ${error.message}`);
  process.exitCode = 1;
}

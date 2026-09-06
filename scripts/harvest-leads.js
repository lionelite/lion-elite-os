#!/usr/bin/env node
'use strict';

// Harvest public posts into lead records and write them where a human can
// read them without a database, a dashboard, or a deploy.
//
//   node scripts/harvest-leads.js                  # all audiences
//   node scripts/harvest-leads.js --audience=coach-scaling
//   node scripts/harvest-leads.js --dry-run        # print, write nothing
//
// Output (under leads/harvested/):
//   leads.jsonl   append-only, deduped by post URI — the machine-readable set
//   latest.md     the newest run, grouped by lane, newest and best first
//   all-leads.md  every lead ever harvested, same grouping
//
// Runs on the GitHub Actions runner, which has the outbound network access
// the dev sandbox does not.

const fs = require('fs');
const path = require('path');
const { harvestBluesky, SEARCH_QUERIES } = require('../lib/leads/harvest');
const { AUDIENCE_PROFILES } = require('../social-listening/src/audience-profiles');

const OUT_DIR = path.join(__dirname, '..', 'leads', 'harvested');
const JSONL = path.join(OUT_DIR, 'leads.jsonl');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

function readExisting() {
  if (!fs.existsSync(JSONL)) return [];
  return fs
    .readFileSync(JSONL, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function laneSections(leads) {
  const byAudience = new Map();
  for (const lead of leads) {
    if (!byAudience.has(lead.audience)) byAudience.set(lead.audience, []);
    byAudience.get(lead.audience).push(lead);
  }
  return byAudience;
}

function renderLead(lead) {
  const when = lead.postedAt ? new Date(lead.postedAt).toISOString().slice(0, 16).replace('T', ' ') : 'unknown';
  const terms = [...(lead.matchedTerms?.subject || []), ...(lead.matchedTerms?.intent || [])].slice(0, 6).join(', ');
  const lines = [
    `### ${lead.name || lead.handle} — score ${lead.score}`,
    '',
    `- **Handle:** [@${lead.handle}](${lead.profileUrl})`,
    `- **Said this:** [view the post](${lead.postUrl}) · ${when} UTC`,
    `- **Why they matched:** ${terms || 'n/a'}`,
    '',
    `> ${String(lead.text).replace(/\n+/g, '\n> ')}`,
    ''
  ];
  // Pushed conditionally rather than filtered out afterwards: filtering empty
  // strings would also swallow the blank lines that keep the blockquote from
  // absorbing whatever follows it.
  if (lead.suggestedOpener) {
    lines.push(`**Opener to adapt (send by hand):** ${lead.suggestedOpener}`, '');
  }
  return lines.join('\n');
}

function renderDigest(title, leads, summary) {
  const lines = [
    `# ${title}`,
    '',
    `_Generated ${new Date().toISOString()} — ${leads.length} lead${leads.length === 1 ? '' : 's'}._`,
    ''
  ];

  if (summary) {
    lines.push(
      '| Searches | Posts read | Matched | Dropped (do-not-engage) |',
      '|---:|---:|---:|---:|',
      `| ${summary.searched} | ${summary.postsSeen} | ${summary.matched} | ${summary.skippedDoNotEngage} |`,
      ''
    );
  }

  lines.push(
    'These are people who posted publicly on Bluesky. Nothing has been sent to',
    'any of them — reach out by hand from the post link if a lead is worth it.',
    ''
  );

  if (leads.length === 0) {
    lines.push('No leads matched this pass. The searches ran; nothing cleared the classifier.', '');
    return lines.join('\n');
  }

  for (const [audience, group] of laneSections(leads)) {
    const profile = AUDIENCE_PROFILES[audience];
    lines.push(`## ${profile?.label || audience} — ${group.length}`, '');
    for (const lead of group) lines.push(renderLead(lead));
  }
  return lines.join('\n');
}

async function main() {
  const audienceArg = arg('audience');
  const audiences = audienceArg ? audienceArg.split(',').map((a) => a.trim()) : Object.keys(SEARCH_QUERIES);
  const perQuery = Number(arg('per-query', '25'));
  const dryRun = has('dry-run');

  console.log(`[harvest] audiences: ${audiences.join(', ')}`);

  const { leads, summary } = await harvestBluesky({ audiences, perQuery });

  console.log(
    `[harvest] ${summary.searched} searches, ${summary.postsSeen} posts read, ` +
    `${summary.matched} matched, ${summary.skippedDoNotEngage} dropped as do-not-engage`
  );
  for (const error of summary.errors) console.log(`[harvest] error: ${error}`);

  if (dryRun) {
    console.log(renderDigest('Lead harvest (dry run)', leads, summary));
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Merge with history: a person who posts again is a fresh lead, but the
  // same post is never stored twice.
  const existing = readExisting();
  const known = new Set(existing.map((lead) => `${lead.audience}:${lead.id}`));
  const fresh = leads.filter((lead) => !known.has(`${lead.audience}:${lead.id}`));
  const all = existing.concat(fresh).sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)));

  fs.writeFileSync(JSONL, all.map((lead) => JSON.stringify(lead)).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'latest.md'), renderDigest('New leads from the last harvest', fresh, summary));
  fs.writeFileSync(path.join(OUT_DIR, 'all-leads.md'), renderDigest('Every harvested lead', all, null));

  console.log(`[harvest] ${fresh.length} new, ${all.length} total -> leads/harvested/`);

  // Surface the count to the workflow so the run summary can show it.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_leads=${fresh.length}\ntotal_leads=${all.length}\n`);
  }
}

main().catch((error) => {
  console.error(`[harvest] failed: ${error.message}`);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

// Harvest public posts into lead records and write them where a human can
// read them without a database, a dashboard, or a deploy.
//
//   node scripts/harvest-leads.js                  # all audiences
//   node scripts/harvest-leads.js --audience=coach-scaling
//   node scripts/harvest-leads.js --business       # also harvest B2B (phone/email)
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
const { harvestBusinesses } = require('../lib/leads/business-harvest');
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
      '| Searches run | Searches failed | Posts read | Matched | Dropped (do-not-engage) |',
      '|---:|---:|---:|---:|---:|',
      `| ${summary.searched} | ${summary.errors.length} | ${summary.postsSeen} | ${summary.matched} | ${summary.skippedDoNotEngage} |`,
      ''
    );

    // A failed source and an empty result look identical in a lead count, and
    // reporting "nothing matched" when nothing was actually queried is how a
    // broken pipeline goes unnoticed. Say which one happened.
    if (summary.errors.length) {
      lines.push(
        `> **${summary.errors.length} search${summary.errors.length === 1 ? '' : 'es'} failed.** ` +
        'The counts below are not "there was nothing to find" — they are what survived the failures.',
        '',
        '<details><summary>What failed</summary>',
        '',
        '```',
        ...summary.errors.slice(0, 40),
        '```',
        '',
        '</details>',
        ''
      );
    }
  }

  lines.push(
    'These are people who posted publicly on Bluesky. Nothing has been sent to',
    'any of them — reach out by hand from the post link if a lead is worth it.',
    ''
  );

  if (leads.length === 0) {
    // Distinguish "asked and got nothing" from "never got to ask".
    if (summary && summary.searched === 0 && summary.errors.length > 0) {
      lines.push('**No leads, because no source could be reached.** Every query failed — see above.', '');
    } else {
      lines.push('No leads matched this pass. The searches ran; nothing cleared the classifier.', '');
    }
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

  // The B2B pass is where phone numbers and emails come from: Bluesky gives a
  // handle, OSM gives a business with published contact details. It reads real
  // small-business websites, so it is opt-in per run rather than always on.
  const existingForSkip = readExisting();
  if (has('business')) {
    const rotation = Number(arg('rotation', String(new Date().getUTCHours())));
    try {
      const known = new Set(existingForSkip.filter((l) => l.source === 'openstreetmap').map((l) => l.id));
      const business = await harvestBusinesses({
        rotation,
        batchSize: Number(arg('batch-size', '25')),
        knownIds: known
      });
      console.log(
        `[harvest] business pass (${business.summary.area}): found ${business.summary.found}, ` +
        `new ${business.leads.length}, already known ${business.summary.skipped}, emails ${business.summary.enriched}`
      );
      leads.push(...business.leads);
    } catch (error) {
      // A blocked Overpass endpoint must not throw away the Bluesky leads
      // already collected in this run.
      console.log(`[harvest] business pass failed: ${error.message}`);
    }
  }

  if (dryRun) {
    console.log(renderDigest('Lead harvest (dry run)', leads, summary));
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Merge with history: a person who posts again is a fresh lead, but the
  // same post is never stored twice.
  const existing = existingForSkip;
  const known = new Set(existing.map((lead) => `${lead.audience}:${lead.id}`));
  const fresh = leads.filter((lead) => !known.has(`${lead.audience}:${lead.id}`));
  const all = existing.concat(fresh).sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)));

  fs.writeFileSync(JSONL, all.map((lead) => JSON.stringify(lead)).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'latest.md'), renderDigest('New leads from the last harvest', fresh, summary));
  fs.writeFileSync(path.join(OUT_DIR, 'all-leads.md'), renderDigest('Every harvested lead', all, null));

  console.log(`[harvest] ${fresh.length} new, ${all.length} total -> leads/harvested/`);

  // Surface the counts to the workflow so the run summary can show them, and
  // flag the case where no source was reachable at all. The workflow commits
  // the digest first and then fails on this flag: a green check on a run that
  // queried nothing is how a dead pipeline stays invisible.
  if (process.env.GITHUB_OUTPUT) {
    const allFailed = summary.searched === 0 && summary.errors.length > 0;
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `new_leads=${fresh.length}\ntotal_leads=${all.length}\nall_failed=${allFailed}\n`
    );
  }
}

main().catch((error) => {
  console.error(`[harvest] failed: ${error.message}`);
  process.exit(1);
});

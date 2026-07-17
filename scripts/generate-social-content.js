#!/usr/bin/env node
'use strict';

// Daily social content orchestrator (Issue #48, Phase 1).
//
// Usage: node scripts/generate-social-content.js [--date=YYYY-MM-DD] [--dry-run] [--no-ai]
//
// For each brand: generate the daily cadence from templates, optionally
// AI-enhance captions (compliance-validated, template fallback), then write
//   content/generated/YYYY-MM-DD/social-content.json
//   content/generated/YYYY-MM-DD/metricool-YYYY-MM-DD.csv
//   content/generated/YYYY-MM-DD/media-prompts.md
//   content/generated/YYYY-MM-DD/generation-log.json
//   content/metricool-import/week-of-YYYY-MM-DD.csv  (Mon-Sun combined)
//
// Exit code 1 means the run itself failed (the workflow opens an issue).
// Compliance blocks do not fail the run: they are reported in the log and
// via GITHUB_OUTPUT `blocked`, and the workflow opens an issue for them.

const fs = require('fs');
const path = require('path');

const { BRAND_KEYS, getBrandProfile } = require('../lib/social/brand-profiles');
const { generateDailyPlan } = require('../lib/social/content-generator');
const { validatePiece } = require('../lib/social/social-compliance');
const { loadHistoryFromDir } = require('../lib/social/topic-rotation');
const { buildMetricoolCsv } = require('../lib/social/metricool-csv');
const { resolveConfig, enhanceCaption } = require('../lib/social/ai-provider');

const REPO_ROOT = path.join(__dirname, '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'content', 'generated');
const IMPORT_DIR = path.join(REPO_ROOT, 'content', 'metricool-import');

// Platform variants worth an AI rewrite. X is skipped (280-char budget is
// already exact) and TikTok scripts are skipped (shot structure matters).
const AI_ELIGIBLE = { feed: ['instagram', 'facebook', 'linkedin'], reel: ['instagram'] };

function parseArgs(argv) {
  const args = { date: null, dryRun: false, ai: true };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--date=')) args.date = arg.slice('--date='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-ai') args.ai = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.date) {
    args.date = new Date().toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date) || Number.isNaN(Date.parse(`${args.date}T00:00:00Z`))) {
    throw new Error(`Invalid --date: ${args.date} (expected YYYY-MM-DD)`);
  }
  return args;
}

async function maybeEnhanceWithAI(piece, profile, aiConfig) {
  const platforms = AI_ELIGIBLE[piece.slot] || [];
  for (const platform of platforms) {
    const variant = piece.platforms[platform];
    if (!variant) continue;
    const candidate = await enhanceCaption({
      profile,
      baseText: variant.text,
      platform,
      config: aiConfig
    });
    if (!candidate) continue;
    const check = validatePiece(
      { ...piece, platforms: { [platform]: { text: candidate } } },
      profile
    );
    if (check.approved) {
      variant.text = candidate;
      variant.aiEnhanced = true;
    }
    // A blocked AI rewrite silently keeps the pre-validated template text.
  }
}

function mondayOf(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function datesOfWeek(mondayStr) {
  const dates = [];
  const date = new Date(`${mondayStr}T00:00:00Z`);
  for (let i = 0; i < 7; i += 1) {
    dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

function collectWeekPieces(monday) {
  const pieces = [];
  for (const day of datesOfWeek(monday)) {
    const file = path.join(GENERATED_DIR, day, 'social-content.json');
    if (!fs.existsSync(file)) continue;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const data of Object.values(payload.brands || {})) {
      pieces.push(...(data.pieces || []));
    }
  }
  return pieces;
}

function buildMediaPromptsMarkdown(date, brandResults) {
  const lines = [`# Media prompts — ${date}`, ''];
  for (const result of brandResults) {
    lines.push(`## ${result.brandName}`, '');
    for (const piece of [...result.pieces, ...result.rejected]) {
      lines.push(
        `### ${piece.id} (${piece.slot}, ${piece.media.dimensions})`,
        '',
        `- Topic: ${piece.topic.title}`,
        `- Format: ${piece.media.format} (${piece.media.aspectRatio}), ${piece.media.dimensions} px`,
        `- Prompt: ${piece.media.prompt}`,
        ''
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeGithubOutput(values) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(outputFile, `${lines.join('\n')}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  const aiConfig = args.ai ? resolveConfig() : { enabled: false };
  const history = loadHistoryFromDir(GENERATED_DIR, { date: args.date });

  console.log(`[social] Generating content for ${args.date}`);
  console.log(`[social] AI enhancement: ${aiConfig.enabled ? `enabled (${aiConfig.model})` : 'disabled (template mode)'}`);
  console.log(`[social] Topic history entries in 7-day window: ${history.length}`);

  const brandResults = [];
  const blocked = [];
  let generatedCount = 0;
  let aiEnhancedCount = 0;

  for (const brand of BRAND_KEYS) {
    const profile = getBrandProfile(brand);
    const plan = generateDailyPlan({ brand, date: args.date, history });
    const approved = [];
    const rejected = [];

    for (const piece of plan.pieces) {
      generatedCount += 1;
      await maybeEnhanceWithAI(piece, profile, aiConfig);
      const compliance = validatePiece(piece, profile);
      piece.compliance = compliance;
      aiEnhancedCount += Object.values(piece.platforms)
        .filter((variant) => variant.aiEnhanced).length;

      if (compliance.approved) {
        approved.push(piece);
        console.log(`[social] generated  ${piece.id} (${piece.topic.slug}, cta=${piece.cta})`);
      } else {
        rejected.push(piece);
        for (const [platform, result] of Object.entries(compliance.platforms)) {
          if (result.approved) continue;
          const codes = result.blockers.map((b) => b.code).join(', ');
          blocked.push({ pieceId: piece.id, platform, blockers: result.blockers });
          console.log(`[social] rejected   ${piece.id} [${platform}]: ${codes}`);
        }
      }
    }

    brandResults.push({
      brand,
      brandName: plan.brandName,
      pieces: approved,
      rejected
    });
  }

  const approvedPieces = brandResults.flatMap((r) => r.pieces);
  const daily = buildMetricoolCsv(approvedPieces);
  const summary = {
    generated: generatedCount,
    approved: approvedPieces.length,
    rejected: generatedCount - approvedPieces.length,
    scheduled: daily.rowCount,
    published: 0, // Phase 1 has no direct publishing; Metricool CSV import is manual.
    aiEnhanced: aiEnhancedCount
  };

  console.log(`[social] Summary: generated=${summary.generated} rejected=${summary.rejected} scheduled=${summary.scheduled} published=${summary.published}`);

  if (args.dryRun) {
    console.log('[social] Dry run — nothing written.');
    writeGithubOutput({ blocked: blocked.length, generated: generatedCount, date: args.date });
    return blocked;
  }

  const dayDir = path.join(GENERATED_DIR, args.date);
  fs.mkdirSync(dayDir, { recursive: true });
  fs.mkdirSync(IMPORT_DIR, { recursive: true });

  const payload = {
    date: args.date,
    generatedAt: new Date().toISOString(),
    brands: Object.fromEntries(brandResults.map((r) => [r.brand, {
      brandName: r.brandName,
      pieces: r.pieces,
      rejected: r.rejected
    }]))
  };
  fs.writeFileSync(path.join(dayDir, 'social-content.json'), `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(path.join(dayDir, `metricool-${args.date}.csv`), daily.csv);
  fs.writeFileSync(path.join(dayDir, 'media-prompts.md'), buildMediaPromptsMarkdown(args.date, brandResults));
  fs.writeFileSync(path.join(dayDir, 'generation-log.json'), `${JSON.stringify({
    date: args.date,
    generatedAt: payload.generatedAt,
    mode: aiConfig.enabled ? 'ai-enhanced' : 'template',
    summary,
    blocked
  }, null, 2)}\n`);

  const monday = mondayOf(args.date);
  const weekly = buildMetricoolCsv(collectWeekPieces(monday));
  const weeklyFile = path.join(IMPORT_DIR, `week-of-${monday}.csv`);
  fs.writeFileSync(weeklyFile, weekly.csv);

  console.log(`[social] Wrote ${path.relative(REPO_ROOT, dayDir)}/ (JSON, CSV, media prompts, log)`);
  console.log(`[social] Wrote ${path.relative(REPO_ROOT, weeklyFile)} (${weekly.rowCount} rows)`);

  writeGithubOutput({ blocked: blocked.length, generated: generatedCount, date: args.date });
  return blocked;
}

main().catch((error) => {
  console.error(`[social] FATAL: ${error.stack || error.message}`);
  writeGithubOutput({ blocked: -1 });
  process.exitCode = 1;
});

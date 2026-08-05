#!/usr/bin/env node
'use strict';

// LEW Peptide Info Series: generate the day's peptide product image (and
// its compliance-checked caption) and drop them where the media-hosting +
// auto-publish pipeline already looks — content/media/<date>/ and a
// peptide-series.json manifest under content/generated/<date>/.
//
//   node scripts/generate-peptide-images.js --start=2026-07-19 [--date=YYYY-MM-DD]
//   node scripts/generate-peptide-images.js --start=2026-07-19 --list   # 18-day plan, no API
//   node scripts/generate-peptide-images.js --start=2026-07-19 --all    # backfill every peptide
//
// Images are produced only when AI image generation is configured
// (AI_IMAGE_ENABLED=true + AI_API_KEY/OPENAI_API_KEY). Without it, the
// prompts + captions are still written so a human can render/drop JPEGs.

const fs = require('fs');
const path = require('path');

const { PEPTIDE_CATALOG, EXCLUDED_PRODUCTS, peptideForDate } = require('../lib/social/peptide-catalog');
const { validateContent } = require('../lib/social/social-compliance');
const { resolveImageConfig, generateImage } = require('../lib/social/media-hosting');
const { buildSiteSourcedCaption, matchPeptide } = require('../lib/social/site-catalog');
const { resolveVial } = require('../lib/social/vial-registry');
const { buildBackgroundPrompt } = require('../lib/social/creative-template');

const REPO_ROOT = path.join(__dirname, '..');

// Load cached lionelitewellness.com product copy (written by
// scripts/fetch-site-catalog.js). When a peptide matches a site product,
// its caption is grounded in the site's own words — sentence-filtered for
// compliance — instead of the catalog default.
function loadSiteCaptions() {
  const file = path.join(REPO_ROOT, 'content', 'site-catalog.json');
  if (!fs.existsSync(file)) return {};
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const bySlug = {};
  for (const product of catalog.products || []) {
    const peptide = matchPeptide(product, PEPTIDE_CATALOG);
    if (!peptide) continue;
    const caption = buildSiteSourcedCaption(product.name, `${product.description} ${product.text}`);
    if (caption) bySlug[peptide.slug] = { caption, sourceUrl: product.url };
  }
  return bySlug;
}

const SITE_CAPTIONS = loadSiteCaptions();

// A peptide's caption, preferring compliant site-sourced copy when available.
function captionFor(peptide) {
  const site = SITE_CAPTIONS[peptide.slug];
  return {
    caption: site ? site.caption : peptide.caption,
    source: site ? 'site' : 'catalog',
    sourceUrl: site ? site.sourceUrl : null
  };
}

function parseArgs(argv) {
  const args = { start: null, date: null, list: false, all: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--start=')) args.start = arg.slice('--start='.length);
    else if (arg.startsWith('--date=')) args.date = arg.slice('--date='.length);
    else if (arg === '--list') args.list = true;
    else if (arg === '--all') args.all = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.start) throw new Error('--start=YYYY-MM-DD (series day 1) is required');
  if (!args.date) args.date = new Date().toISOString().slice(0, 10);
  return args;
}

// pieceId matches the wellness feed piece the publisher targets, so these
// images become the Instagram/Facebook image for that day automatically.
function pieceIdFor(dateStr) {
  return `${dateStr}-wellness-feed`;
}

function assertCompliant(text, name) {
  const result = validateContent({ text, complianceMode: 'research-only' });
  if (!result.approved) {
    throw new Error(`Caption for ${name} failed compliance: ${result.blockers.map((b) => b.code).join(', ')}`);
  }
}

async function renderOne(peptide, dateStr, imageConfig) {
  const { caption, source, sourceUrl } = captionFor(peptide);
  assertCompliant(caption, peptide.name); // site or catalog, both gated
  const rel = `content/media/${dateStr}/${pieceIdFor(dateStr)}.jpg`;
  const abs = path.join(REPO_ROOT, rel);
  // The correct real vial for THIS product, keyed by name so a mismatch
  // (the old SELANK-on-CJC bug) is impossible. When the asset exists we
  // composite it and ask the AI for a vial-free background (empty pedestal).
  const vial = resolveVial(peptide.name);
  const realVial = vial && vial.provided ? vial : null;
  let generated = false;
  let mode = null;
  let vialUsed = realVial ? realVial.file : null;
  if (imageConfig.enabled && !fs.existsSync(abs)) {
    // Approach B (default): AI renders the cinematic background (no text),
    // then the compositor overlays the real vial + crisp brand typography.
    // Falls back to writing the raw background if compositing is unavailable.
    const prompt = realVial
      ? buildBackgroundPrompt({ name: peptide.name, flair: peptide.flair, withVial: false })
      : peptide.backgroundPrompt;
    const background = await generateImage({ prompt, config: imageConfig });
    if (background) {
      try {
        const { composeCreative } = require('../lib/social/creative-compositor');
        const final = await composeCreative({
          backgroundBuffer: background,
          headline: peptide.headline,
          pathways: peptide.pathways,
          vialBuffer: realVial ? fs.readFileSync(realVial.absFile) : undefined
        });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, final);
        generated = true;
        mode = realVial ? 'composited+real-vial' : 'composited';
      } catch (error) {
        // Compositor unavailable (e.g. sharp missing) — write the raw AI
        // background so the run still produces an image.
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, background);
        generated = true;
        mode = `background-only (${error.message})`;
      }
    }
  }
  return { slug: peptide.slug, name: peptide.name, date: dateStr, mediaFile: rel, caption, captionSource: source, sourceUrl, headline: peptide.headline, pathways: peptide.pathways, vialFile: vialUsed, imageMode: mode, imageGenerated: generated, imageExists: fs.existsSync(abs) };
}

async function main() {
  const args = parseArgs(process.argv);
  const imageConfig = resolveImageConfig();

  console.log(`[peptide] Series start ${args.start}. AI images: ${imageConfig.enabled ? `on (${imageConfig.model})` : 'off — prompts/captions only'}.`);
  if (EXCLUDED_PRODUCTS.length) {
    console.log('[peptide] Excluded from auto-generation (owner decision required):');
    for (const ex of EXCLUDED_PRODUCTS) console.log(`  - ${ex.name}: ${ex.reason}`);
  }

  if (args.list) {
    const siteCount = Object.keys(SITE_CAPTIONS).length;
    for (let i = 0; i < PEPTIDE_CATALOG.length; i += 1) {
      const p = PEPTIDE_CATALOG[i];
      const { caption, source } = captionFor(p);
      assertCompliant(caption, p.name);
      console.log(`  Day ${String(i + 1).padStart(2)} · ${p.name} — ${p.researchArea} [${source} caption OK]`);
    }
    console.log(`[peptide] ${PEPTIDE_CATALOG.length} approved peptides, all captions pass compliance (${siteCount} grounded in site copy).`);
    return;
  }

  const manifest = [];
  if (args.all) {
    const start = new Date(`${args.start}T00:00:00Z`);
    for (let i = 0; i < PEPTIDE_CATALOG.length; i += 1) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      manifest.push(await renderOne(PEPTIDE_CATALOG[i], dateStr, imageConfig));
    }
  } else {
    const { peptide, dayNumber } = peptideForDate(args.date, args.start);
    console.log(`[peptide] ${args.date} = series day ${dayNumber}: ${peptide.name}`);
    manifest.push(await renderOne(peptide, args.date, imageConfig));
  }

  const outDir = path.join(REPO_ROOT, 'content', 'generated', args.date);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'peptide-series.json'), `${JSON.stringify({ start: args.start, generatedAt: new Date().toISOString(), items: manifest }, null, 2)}\n`);

  const rendered = manifest.filter((m) => m.imageGenerated).length;
  const present = manifest.filter((m) => m.imageExists).length;
  console.log(`[peptide] ${manifest.length} day(s): ${rendered} image(s) generated, ${present} with an image file present.`);
  if (!imageConfig.enabled) {
    console.log('[peptide] To render images: set AI_IMAGE_ENABLED=true + AI_API_KEY and rerun, or drop JPEGs at the listed mediaFile paths.');
  }
}

main().catch((error) => {
  console.error(`[peptide] FATAL: ${error.message}`);
  process.exitCode = 1;
});

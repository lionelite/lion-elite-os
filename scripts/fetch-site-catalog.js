#!/usr/bin/env node
'use strict';

// Fetch lionelitewellness.com product pages and cache extracted, compliance-
// matched product info to content/site-catalog.json. Runs where the site is
// reachable (GitHub Actions runner / any box with internet) — NOT the
// sandbox, whose network policy blocks the domain.
//
//   node scripts/fetch-site-catalog.js --urls=content/site-urls.txt
//   SITE_PRODUCT_URLS="https://lionelitewellness.com/product/retatrutide,..." node scripts/fetch-site-catalog.js
//
// site-urls.txt: one product-page URL per line (# comments allowed).

const fs = require('fs');
const path = require('path');
const { extractProduct } = require('../lib/social/site-catalog');

const REPO_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { urlsFile: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--urls=')) args.urlsFile = arg.slice('--urls='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadUrls(args) {
  if (process.env.SITE_PRODUCT_URLS) {
    return process.env.SITE_PRODUCT_URLS.split(',').map((u) => u.trim()).filter(Boolean);
  }
  const file = args.urlsFile || path.join(REPO_ROOT, 'content', 'site-urls.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function fetchOne(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'LionEliteOS-SiteCatalog/1.0 (+own-site content sync)' }
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'FETCH_FAILED' });
  return response.text();
}

async function main() {
  const args = parseArgs(process.argv);
  const urls = loadUrls(args);
  if (urls.length === 0) {
    console.error('[site] No URLs. Provide content/site-urls.txt (one product URL per line) or SITE_PRODUCT_URLS.');
    process.exitCode = 1;
    return;
  }

  const products = [];
  for (const url of urls) {
    try {
      const html = await fetchOne(url);
      const product = extractProduct(html, url);
      products.push(product);
      console.log(`[site] ok    ${url} → "${product.name}" (${product.text.length} chars)`);
    } catch (error) {
      console.log(`[site] fail  ${url}: ${error.message}`);
    }
  }

  const outFile = path.join(REPO_ROOT, 'content', 'site-catalog.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify({ fetchedAt: new Date().toISOString(), products }, null, 2)}\n`);
  console.log(`[site] Wrote ${path.relative(REPO_ROOT, outFile)} with ${products.length} product(s).`);
}

main().catch((error) => {
  console.error(`[site] FATAL: ${error.message}`);
  process.exitCode = 1;
});

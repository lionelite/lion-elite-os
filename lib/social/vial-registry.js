'use strict';

// Canonical product-vial registry. One correct image per product, keyed by
// product, so ANY marketing content (peptide posts, the compositor, ads,
// Metricool, the site) pulls the RIGHT vial by name — the wrong-vial bug
// (SELANK on a CJC post) becomes impossible because lookup is by product.
//
// The product list is sourced from the approved peptide catalog (single
// source of truth), and can be extended by an optional
// content/media/vials/manifest.json for products beyond it. Drop the real
// vial asset at content/media/vials/<slug>.png — ideally a TRANSPARENT-
// background PNG cutout so it composites cleanly onto any scene.

const fs = require('fs');
const path = require('path');
const { PEPTIDE_CATALOG } = require('./peptide-catalog');

const VIALS_DIR = path.join(__dirname, '..', '..', 'content', 'media', 'vials');
const MANIFEST_FILE = path.join(VIALS_DIR, 'manifest.json');

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\band\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

// Auto-aliases so a lookup by display name, slug, or common spelling all
// resolve to the same product (e.g. "CJC/Ipamorelin", "cjc 1295").
function aliasesFor(entry) {
  const set = new Set([normalizeKey(entry.slug), normalizeKey(entry.name)]);
  set.add(normalizeKey(entry.name.replace(/[/]/g, ' ')));
  for (const a of entry.aliases || []) set.add(normalizeKey(a));
  return [...set].filter(Boolean);
}

function loadManifestExtras() {
  if (!fs.existsSync(MANIFEST_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    return Array.isArray(data.products) ? data.products : [];
  } catch {
    return [];
  }
}

function vialRelPath(slug) {
  return `content/media/vials/${slug}.png`;
}

// The full product set: approved catalog + manifest extras (deduped by slug).
function products() {
  const bySlug = new Map();
  for (const p of PEPTIDE_CATALOG) {
    bySlug.set(p.slug, { slug: p.slug, name: p.name, aliases: [] });
  }
  for (const extra of loadManifestExtras()) {
    if (!extra.slug || !extra.name) continue;
    const existing = bySlug.get(extra.slug) || { slug: extra.slug, name: extra.name, aliases: [] };
    existing.aliases = [...(existing.aliases || []), ...(extra.aliases || [])];
    existing.name = extra.name || existing.name;
    bySlug.set(extra.slug, existing);
  }
  return [...bySlug.values()].map((p) => {
    const rel = vialRelPath(p.slug);
    return {
      slug: p.slug,
      name: p.name,
      aliases: aliasesFor(p),
      file: rel,
      absFile: path.join(__dirname, '..', '..', rel),
      provided: fs.existsSync(path.join(__dirname, '..', '..', rel))
    };
  });
}

/**
 * Resolve a product name / slug / alias to its registry entry.
 * Returns the entry (with `provided` = whether the real asset exists) or
 * null if the product is unknown to the registry.
 */
function resolveVial(query) {
  const key = normalizeKey(query);
  if (!key) return null;
  const all = products();
  return all.find((p) => p.aliases.includes(key)) ||
    all.find((p) => p.aliases.some((a) => a === key || a.startsWith(key) || key.startsWith(a))) ||
    null;
}

/**
 * Coverage report: which products have a real vial asset and which are
 * still missing. Use while building the library.
 */
function coverage() {
  const all = products();
  const provided = all.filter((p) => p.provided);
  return {
    total: all.length,
    provided: provided.length,
    missing: all.filter((p) => !p.provided).map((p) => p.slug),
    products: all.map((p) => ({ slug: p.slug, name: p.name, provided: p.provided, file: p.file }))
  };
}

module.exports = { VIALS_DIR, normalizeKey, vialRelPath, products, resolveVial, coverage };

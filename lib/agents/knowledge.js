'use strict';

// Per-agent knowledge bases, built from the owner's own data.
//
// The point: an agent reasoning from generic priors gives generic advice. An
// agent that has indexed `sales/master-sales-framework.md`, the swipe database and
// the outreach campaign definitions gives advice grounded in how this business
// actually operates — and can cite where each claim came from.
//
// Design constraints, all deliberate:
//
//   CITATIONS ON EVERY FACT. Each extracted item carries `file` and `line`, the
//   same discipline the video-learning module applies with timestamps. An agent
//   assertion nobody can trace is an assertion nobody should act on.
//
//   DETERMINISTIC AND OFFLINE. No model call, no network, no secrets. The same
//   repo state always produces the same knowledge base, so a change in an
//   agent's behaviour is attributable to a change in the data. Optional LLM
//   summarisation can sit on top later; the base layer must work with zero
//   configuration, like the social content generator does.
//
//   MISSING SOURCES ARE REPORTED, NOT SKIPPED. A role pointing at a file that
//   does not exist is a broken agent, and it must be visible rather than
//   degrading quietly into a thinner knowledge base.
//
//   RUO LANGUAGE IS FLAGGED. Several source documents quote the dosing and
//   human-use phrasing they exist to prohibit. An agent that indexes those and
//   parrots them back into customer-facing copy is a compliance incident, so a
//   source carrying that language is marked `internalOnly` — adopt the rule,
//   never the wording. Same treatment video-learning gives creator transcripts.

const fs = require('node:fs');
const path = require('node:path');

const { role, ROLES } = require('./roles');
const { validateContent } = require('../social/social-compliance');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Only text we can actually read as prose or config.
const INDEXABLE = new Set(['.md', '.json', '.txt']);

// Directories never worth indexing.
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__']);

// Cap per source file so one enormous document cannot crowd out every other
// source in a role's knowledge base.
const MAX_FACTS_PER_SOURCE = 40;
const MAX_FILE_BYTES = 512 * 1024;

function isIndexable(file) {
  return INDEXABLE.has(path.extname(file).toLowerCase());
}

function walk(absolute, collected = [], depth = 0) {
  if (depth > 6) return collected;
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(child, collected, depth + 1);
    } else if (entry.isFile() && isIndexable(entry.name)) {
      collected.push(child);
    }
  }
  return collected;
}

/**
 * Resolve a role's declared domains into concrete files, reporting any domain
 * that resolved to nothing.
 */
function resolveSources(domains, { root = REPO_ROOT } = {}) {
  const files = [];
  const missing = [];
  for (const domain of domains) {
    const absolute = path.join(root, domain);
    if (!fs.existsSync(absolute)) {
      missing.push(domain);
      continue;
    }
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      const found = walk(absolute);
      if (!found.length) missing.push(`${domain} (no indexable files)`);
      files.push(...found);
    } else if (isIndexable(absolute)) {
      files.push(absolute);
    } else {
      missing.push(`${domain} (not an indexable type)`);
    }
  }
  return { files: [...new Set(files)], missing };
}

// A stated number worth remembering: money, percentage, or an explicit target.
const NUMBER_PATTERN = /(\$\s?[\d,]+(?:\.\d+)?(?:\s?[kKmM])?|\b\d+(?:\.\d+)?\s?%|\b\d+\s?(?:\/|per\s)\s?(?:day|week|month|year)\b)/;

// A directive: something the business has decided, not prose about it.
const DIRECTIVE_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+\S/;

function classify(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^#{1,6}\s+\S/.test(trimmed)) return 'structure';
  if (NUMBER_PATTERN.test(trimmed)) return 'stated-number';
  if (DIRECTIVE_PATTERN.test(trimmed)) return 'directive';
  return null;
}

function extractFacts(absolute, { root = REPO_ROOT } = {}) {
  const relative = path.relative(root, absolute);
  let raw;
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_FILE_BYTES) {
      return { file: relative, skipped: `larger than ${MAX_FILE_BYTES} bytes`, facts: [], internalOnly: false };
    }
    raw = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    return { file: relative, skipped: error.message, facts: [], internalOnly: false };
  }

  // JSON sources are data, not prose — record shape rather than pretending to
  // read sentences out of them.
  if (path.extname(absolute).toLowerCase() === '.json') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { file: relative, skipped: `unparseable JSON: ${error.message}`, facts: [], internalOnly: false };
    }
    const keys = Array.isArray(parsed) ? [`array of ${parsed.length}`] : Object.keys(parsed).slice(0, 20);
    return {
      file: relative,
      facts: [{ kind: 'dataset', text: `Dataset with ${Array.isArray(parsed) ? `${parsed.length} records` : `keys: ${keys.join(', ')}`}`, file: relative, line: 1 }],
      internalOnly: false,
      skipped: null,
    };
  }

  const lines = raw.split('\n');
  const facts = [];
  for (let i = 0; i < lines.length && facts.length < MAX_FACTS_PER_SOURCE; i += 1) {
    const kind = classify(lines[i]);
    if (!kind) continue;
    const text = lines[i].trim().replace(/^#{1,6}\s+/, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/, '');
    if (text.length < 8) continue;
    facts.push({ kind, text: text.slice(0, 300), file: relative, line: i + 1 });
  }

  // Does this source quote the language it exists to prohibit? Checked in
  // research-only mode without requiring the disclaimer — we are asking "does
  // this contain dosing/human-use phrasing", not "is this publishable copy".
  const compliance = validateContent({ text: raw, complianceMode: 'research-only', requireDisclaimer: false });
  const internalOnly = !compliance.approved;

  return {
    file: relative,
    facts,
    internalOnly,
    complianceBlockers: internalOnly ? compliance.blockers.map((b) => b.code) : [],
    skipped: null,
  };
}

/**
 * Build one role's knowledge base.
 *
 * Returns the indexed sources with citations, the domains that resolved to
 * nothing, and a per-kind count. `internalOnly` sources are usable for reasoning
 * but their wording must never reach customer-facing output.
 */
function buildKnowledge(roleId, { root = REPO_ROOT } = {}) {
  const definition = role(roleId);
  if (!definition) throw new Error(`Unknown role "${roleId}".`);

  const { files, missing } = resolveSources(definition.knowledgeDomains, { root });
  const sources = files.map((f) => extractFacts(f, { root }));

  const facts = sources.flatMap((s) => s.facts);
  const byKind = facts.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] || 0) + 1;
    return acc;
  }, {});

  return {
    roleId,
    title: definition.title,
    mandate: definition.mandate,
    sources: sources.filter((s) => !s.skipped),
    skippedSources: sources.filter((s) => s.skipped).map((s) => ({ file: s.file, reason: s.skipped })),
    missingDomains: missing,
    internalOnlySources: sources.filter((s) => s.internalOnly).map((s) => s.file),
    facts,
    factCount: facts.length,
    byKind,
    // An agent with no evidence base should say so rather than improvise.
    grounded: facts.length > 0,
  };
}

/** Build every role's knowledge base. */
function buildAll({ root = REPO_ROOT } = {}) {
  return ROLES.map((r) => buildKnowledge(r.id, { root }));
}

/**
 * Look up what a role knows about a topic, with citations.
 *
 * Plain substring/keyword scoring rather than embeddings: it is deterministic,
 * needs no model, and for a corpus this size it is enough. The citations are the
 * valuable part — they let a human check the agent.
 */
function recall(knowledge, query, { limit = 8 } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return [];
  const scored = knowledge.facts.map((fact) => {
    const haystack = fact.text.toLowerCase();
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score += 1;
    // A stated number matching the query is usually what was actually wanted.
    if (score > 0 && fact.kind === 'stated-number') score += 0.5;
    return { ...fact, score };
  }).filter((f) => f.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Coverage report across every role — which agents are actually grounded. */
function coverageReport({ root = REPO_ROOT } = {}) {
  const all = buildAll({ root });
  return {
    roles: all.map((k) => ({
      roleId: k.roleId,
      title: k.title,
      sources: k.sources.length,
      facts: k.factCount,
      grounded: k.grounded,
      missingDomains: k.missingDomains,
      internalOnlySources: k.internalOnlySources.length,
    })),
    ungrounded: all.filter((k) => !k.grounded).map((k) => k.roleId),
    totalFacts: all.reduce((n, k) => n + k.factCount, 0),
    brokenDomains: all.flatMap((k) => k.missingDomains.map((d) => ({ roleId: k.roleId, domain: d }))),
  };
}

module.exports = {
  REPO_ROOT,
  INDEXABLE,
  MAX_FACTS_PER_SOURCE,
  resolveSources,
  classify,
  extractFacts,
  buildKnowledge,
  buildAll,
  recall,
  coverageReport,
};

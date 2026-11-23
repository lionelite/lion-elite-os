'use strict';

// The repo root is an Obsidian vault (knowledge/obsidian.md). Home and the maps
// are how anyone, human or agent, finds a doc, so a link that points at a file
// that was moved or deleted is a silent dead end. This fails CI instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE = path.join(ROOT, 'knowledge');

function vaultEntryNotes() {
  const maps = fs.readdirSync(path.join(KNOWLEDGE, 'maps'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join('knowledge', 'maps', f));
  return [
    'knowledge/Home.md',
    'knowledge/obsidian.md',
    'knowledge/inbox/Inbox.md',
    'knowledge/decisions/README.md',
    ...maps,
  ];
}

function wikilinks(markdown) {
  const out = [];
  // Ignore fenced and inline code so documented examples are not checked.
  const text = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

function resolves(target) {
  const withExt = target.endsWith('.md') ? target : `${target}.md`;
  return fs.existsSync(path.join(ROOT, withExt));
}

test('every vault entry note exists', () => {
  for (const note of vaultEntryNotes()) {
    assert.ok(fs.existsSync(path.join(ROOT, note)), `missing ${note}`);
  }
});

test('every wikilink on Home and the maps points at a real file', () => {
  const broken = [];
  for (const note of vaultEntryNotes()) {
    const body = fs.readFileSync(path.join(ROOT, note), 'utf8');
    for (const target of wikilinks(body)) {
      if (!resolves(target)) broken.push(`${note} -> [[${target}]]`);
    }
  }
  assert.deepEqual(broken, [], `broken vault links:\n${broken.join('\n')}`);
});

test('Home links every map', () => {
  const home = fs.readFileSync(path.join(KNOWLEDGE, 'Home.md'), 'utf8');
  const linked = new Set(wikilinks(home));
  const maps = fs.readdirSync(path.join(KNOWLEDGE, 'maps'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `knowledge/maps/${f.replace(/\.md$/, '')}`);
  const missing = maps.filter((m) => !linked.has(m));
  assert.deepEqual(missing, [], `maps not linked from Home: ${missing.join(', ')}`);
});

test('shared Obsidian settings are valid JSON and per-device state is not committed', () => {
  for (const f of ['app.json', 'core-plugins.json', 'daily-notes.json', 'templates.json', 'community-plugins.json', 'bookmarks.json', 'plugins/obsidian-git/data.json']) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(ROOT, '.obsidian', f), 'utf8')), f);
  }
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.obsidian\/workspace\.json$/m);
  assert.match(ignore, /^\.obsidian\/workspace-mobile\.json$/m);
});

test('templates and daily notes point at folders that exist', () => {
  const daily = JSON.parse(fs.readFileSync(path.join(ROOT, '.obsidian', 'daily-notes.json'), 'utf8'));
  const templates = JSON.parse(fs.readFileSync(path.join(ROOT, '.obsidian', 'templates.json'), 'utf8'));
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, '.obsidian', 'app.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(ROOT, daily.folder)), daily.folder);
  assert.ok(resolves(daily.template), daily.template);
  assert.ok(fs.existsSync(path.join(ROOT, templates.folder)), templates.folder);
  assert.ok(fs.existsSync(path.join(ROOT, app.newFileFolderPath)), app.newFileFolderPath);
  assert.ok(fs.existsSync(path.join(ROOT, app.attachmentFolderPath)), app.attachmentFolderPath);
});

'use strict';

// Append-only JSONL store for surfaced matches, one file per day under
// social-listening/data/ (gitignored — matches contain third-party post
// text and should not be committed).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function matchFile(dateStr, dataDir = DATA_DIR) {
  return path.join(dataDir, `matches-${dateStr}.jsonl`);
}

function appendMatch(entry, dataDir = DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(matchFile(dateStr, dataDir), `${JSON.stringify(entry)}\n`);
}

function loadRecentMatches({ days = 3, dataDir = DATA_DIR } = {}) {
  const entries = [];
  if (!fs.existsSync(dataDir)) return entries;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dataDir)) {
    const match = name.match(/^matches-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) continue;
    if (Date.parse(`${match[1]}T00:00:00Z`) < cutoff - 24 * 60 * 60 * 1000) continue;
    const lines = fs.readFileSync(path.join(dataDir, name), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip torn writes; the stream continues.
      }
    }
  }
  entries.sort((a, b) => (b.seenAt || '').localeCompare(a.seenAt || ''));
  return entries;
}

module.exports = { DATA_DIR, appendMatch, loadRecentMatches, matchFile };

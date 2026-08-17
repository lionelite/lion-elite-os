'use strict';

// The owner-facing half of the video learning connection.
//
// The inbox is a plain markdown list so it can be edited from a phone, from
// the GitHub web UI, or by a script — no app, no form, no API token. Anything
// that looks like a link is accepted; the rest of the line is read as the
// instruction that goes with it:
//
//   - https://youtu.be/abc123 — build an ad angle from this
//   - https://www.instagram.com/reel/XYZ  | steal the hook structure
//
// Parsing is pure and forgiving, but it never guesses: a line whose link is
// not a supported single-video URL is reported as invalid rather than
// silently skipped, so a typo surfaces instead of quietly doing nothing.

const { parseVideoUrl } = require('./video-sources');

// Separators owners actually type between a link and an instruction. The
// instruction can sit on either side of the link, so both a leading separator
// ("— build an ad angle") and a trailing one ("watch this one:") are trimmed.
const LEADING_SEPARATOR = /^\s*(?:[—–-]{1,2}|\||::|:|→|>)\s*/;
const TRAILING_SEPARATOR = /\s*(?:[—–-]{1,2}|\||::|:|→|>)\s*$/;
const URL_TOKEN = /\b(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com|instagram\.com|instagr\.am)\/\S+/i;

function stripBullet(line) {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
}

function isSkippable(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('#')) return true; // heading
  if (trimmed.startsWith('<!--')) return true; // html comment
  if (trimmed.startsWith('>')) return true; // blockquote / instructions
  if (/^[-*_]{3,}$/.test(trimmed)) return true; // horizontal rule
  return false;
}

function cleanTask(text) {
  // Drop one separator from each end; dashes inside the sentence stay.
  return String(text || '')
    .trim()
    .replace(LEADING_SEPARATOR, '')
    .replace(TRAILING_SEPARATOR, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the inbox file into queued video items.
 *
 * @param {string} text - contents of the inbox markdown file
 * @returns {{items: Array<{url: string, source: object, task: string|null,
 *   raw: string, line: number}>, invalid: Array<{raw: string, line: number,
 *   reason: string}>}}
 */
function parseInbox(text) {
  const items = [];
  const invalid = [];
  const seen = new Set();

  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  lines.forEach((rawLine, index) => {
    if (isSkippable(rawLine)) return;

    const line = stripBullet(rawLine);
    if (!line) return;

    const match = URL_TOKEN.exec(line);
    if (!match) {
      invalid.push({ raw: line, line: index + 1, reason: 'no YouTube or Instagram link found' });
      return;
    }

    const url = match[0];
    const source = parseVideoUrl(url);
    if (!source) {
      invalid.push({
        raw: line,
        line: index + 1,
        reason: 'link is not a single YouTube or Instagram video'
      });
      return;
    }

    // Instruction text can sit on either side of the link; each side is
    // trimmed on its own so the separator never survives into the middle.
    const before = cleanTask(line.slice(0, match.index));
    const after = cleanTask(line.slice(match.index + url.length));
    const task = [before, after].filter(Boolean).join(' ') || null;

    if (seen.has(source.sourceKey)) return;
    seen.add(source.sourceKey);

    items.push({ url, source, task, raw: line, line: index + 1 });
  });

  return { items, invalid };
}

/**
 * Remove processed entries from the inbox text. History lives in the lesson
 * index, so a processed line is deleted rather than annotated — the inbox
 * stays a to-do list instead of growing into a log.
 *
 * @param {string} text - current inbox contents
 * @param {Array<string>} sourceKeys - keys of videos that were processed
 * @returns {string} updated inbox contents
 */
function removeProcessed(text, sourceKeys) {
  const done = new Set(sourceKeys || []);
  if (done.size === 0) return String(text || '');

  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const kept = lines.filter((rawLine) => {
    if (isSkippable(rawLine)) return true;
    const match = URL_TOKEN.exec(stripBullet(rawLine));
    if (!match) return true;
    const source = parseVideoUrl(match[0]);
    return !source || !done.has(source.sourceKey);
  });

  // Collapse the blank-line runs left behind by removed entries.
  const collapsed = [];
  for (const line of kept) {
    if (!line.trim() && !collapsed[collapsed.length - 1]?.trim() && collapsed.length > 0) continue;
    collapsed.push(line);
  }
  return `${collapsed.join('\n').trimEnd()}\n`;
}

module.exports = {
  parseInbox,
  removeProcessed,
  cleanTask,
  stripBullet
};

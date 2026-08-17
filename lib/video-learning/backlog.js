'use strict';

// The consolidated view across every video lesson.
//
// A folder of one-file-per-video is a filing cabinet, not a to-do list. This
// renders every proposal from every lesson into a single working list, grouped
// by business lane, with the source citation kept on each line.
//
// The list is regenerated from index.json on every run, so the one thing it
// must not do is throw away the owner's progress. Each proposal carries a
// stable id derived from its video and its source line; ticked boxes are read
// out of the existing file and carried across, which is what makes a
// regenerated checklist safe to tick.

const { LANES } = require('./task-proposal');

const BACKLOG_FILE = 'backlog.md';
// Trailing HTML comment on each line: invisible when rendered, stable to parse.
const ID_MARKER = /<!--\s*id:([0-9a-f]{4,40})\s*-->/i;

const LANE_LABELS = new Map([
  ...LANES.map((lane) => [lane.id, lane.label]),
  ['general', 'General business']
]);

/**
 * Read the ids of already-ticked items out of an existing backlog file, so a
 * regeneration preserves them.
 *
 * @param {string} markdown - current backlog.md contents ('' if absent)
 * @returns {Set<string>} ids the owner has checked off
 */
function parseCheckedIds(markdown) {
  const checked = new Set();
  for (const line of String(markdown || '').split('\n')) {
    // Only a ticked checkbox counts; an unticked one carries no state.
    if (!/^\s*[-*]\s*\[[xX]\]/.test(line)) continue;
    const match = ID_MARKER.exec(line);
    if (match) checked.add(match[1].toLowerCase());
  }
  return checked;
}

/** Flatten index entries into one proposal list, newest video first. */
function collectProposals(entries) {
  const collected = [];
  for (const entry of entries || []) {
    for (const proposal of entry.proposals || []) {
      collected.push({
        ...proposal,
        sourceKey: entry.sourceKey,
        sourceTitle: entry.title,
        sourceFile: entry.file,
        capturedAt: entry.capturedAt
      });
    }
  }
  return collected;
}

function groupByLane(proposals) {
  const groups = new Map();
  for (const proposal of proposals) {
    const lane = proposal.lane || 'general';
    if (!groups.has(lane)) groups.set(lane, []);
    groups.get(lane).push(proposal);
  }
  // Biggest lanes first; 'general' always last since it is the fallback bucket.
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === 'general') return 1;
    if (b[0] === 'general') return -1;
    return b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });
}

function renderProposal(proposal, checkedIds) {
  const done = checkedIds.has(String(proposal.id).toLowerCase());
  const citation = proposal.citation
    ? ` [\`${proposal.citation.label}\`](${proposal.citation.url})`
    : '';
  const lines = [
    `- [${done ? 'x' : ' '}] **${proposal.title}** <!-- id:${proposal.id} -->`,
    `  ${citation ? `${citation.trim()} · ` : ''}from [${proposal.sourceTitle}](${proposal.sourceFile})`
  ];
  if (proposal.requiresOwnerAction) {
    lines.push(`  - ⚠ ${proposal.ownerActionReason}`);
  }
  if (proposal.customerFacingSafe === false) {
    lines.push('  - Internal wording only — rewrite before anything ships.');
  }
  return lines;
}

/**
 * Render the whole backlog.
 *
 * @param {Array} entries - index.json entries
 * @param {object} [options]
 * @param {Set<string>} [options.checkedIds] - ids already ticked off
 * @returns {string} backlog markdown
 */
function renderBacklog(entries, { checkedIds = new Set() } = {}) {
  const proposals = collectProposals(entries);
  const lines = ['# Video Lesson Backlog', ''];

  lines.push(
    'Every proposal extracted from a video, in one place. **Nothing here has ' +
      'been executed** — tick an item when you have decided to do it, and the ' +
      'tick survives the next regeneration.'
  );
  lines.push('');
  lines.push(
    'Items marked ⚠ would cross a hard limit and stay blocked until you act on ' +
      'the named control. This file is generated — edit the checkboxes, not the text.'
  );
  lines.push('');

  if (proposals.length === 0) {
    lines.push('_No proposals yet. Queue a video in [`inbox.md`](inbox.md)._');
    return `${lines.join('\n')}\n`;
  }

  const open = proposals.filter((proposal) => !checkedIds.has(String(proposal.id).toLowerCase()));
  const blocked = open.filter((proposal) => proposal.requiresOwnerAction);
  const videos = new Set(proposals.map((proposal) => proposal.sourceKey)).size;

  lines.push(
    `${open.length} open of ${proposals.length} proposals, from ${videos} ` +
      `video${videos === 1 ? '' : 's'}${blocked.length > 0 ? ` · ${blocked.length} awaiting an owner decision` : ''}.`
  );
  lines.push('');

  for (const [lane, laneProposals] of groupByLane(proposals)) {
    const laneOpen = laneProposals.filter(
      (proposal) => !checkedIds.has(String(proposal.id).toLowerCase())
    ).length;
    lines.push(`## ${LANE_LABELS.get(lane) || lane} (${laneOpen} open)`);
    lines.push('');
    // Done items sink to the bottom of their lane so the work is on top.
    const ordered = [...laneProposals].sort((a, b) => {
      const aDone = checkedIds.has(String(a.id).toLowerCase()) ? 1 : 0;
      const bDone = checkedIds.has(String(b.id).toLowerCase()) ? 1 : 0;
      return aDone - bDone || String(b.capturedAt).localeCompare(String(a.capturedAt));
    });
    for (const proposal of ordered) lines.push(...renderProposal(proposal, checkedIds));
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

module.exports = {
  renderBacklog,
  parseCheckedIds,
  collectProposals,
  groupByLane,
  BACKLOG_FILE
};

#!/usr/bin/env node
'use strict';

// Local review dashboard for surfaced Bluesky posts. Read-only: renders
// what the monitor stored, links each post so a HUMAN can open it on
// bsky.app and decide whether (and how) to engage from their own account.
// Nothing here authenticates to Bluesky or sends anything anywhere.
//
//   node social-listening/src/review-server.js   (port: LISTEN_REVIEW_PORT, default 4600)

const express = require('express');
const { loadRecentMatches } = require('./store');

const PORT = Number(process.env.LISTEN_REVIEW_PORT || 4600);

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRow(entry) {
  const { post, match } = entry;
  const badge = match.doNotEngage
    ? '<span class="badge stop">DO NOT ENGAGE</span>'
    : match.lowPriority
      ? '<span class="badge low">low priority</span>'
      : '<span class="badge ok">review</span>';
  const model = match.model
    ? `<div class="meta">model: ${escapeHtml(match.model.intent)} (${(match.model.confidence * 100).toFixed(0)}%)${match.model.humanUse ? ' · human-use' : ''}</div>`
    : '';
  const guidance = match.doNotEngage
    ? `<div class="reason">${escapeHtml(match.doNotEngageReason)}</div>`
    : match.suggestedOpener
      ? `<div class="opener">Suggested opener (adapt + send manually from your own account): ${escapeHtml(match.suggestedOpener)}</div>`
      : '';
  return `
  <article class="card ${match.doNotEngage ? 'stop' : ''}">
    <header>
      <strong>${escapeHtml(match.audience)}</strong> · score ${match.score} · ${escapeHtml(entry.seenAt)} ${badge}
    </header>
    <p class="text">${escapeHtml(post.text)}</p>
    <div class="meta">subject: ${escapeHtml(match.matched.subject.join(', '))} · intent: ${escapeHtml(match.matched.intent.join(', '))}</div>
    ${model}
    ${guidance}
    <a href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Open post on bsky.app →</a>
  </article>`;
}

function renderPage(entries, { audience, showAll }) {
  const filtered = entries.filter((entry) => {
    if (audience && entry.match.audience !== audience) return false;
    if (!showAll && entry.match.lowPriority) return false;
    return true;
  });
  const counts = {
    total: entries.length,
    shown: filtered.length,
    doNotEngage: filtered.filter((e) => e.match.doNotEngage).length
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Bluesky Listening Review</title>
<meta http-equiv="refresh" content="30">
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 780px; padding: 0 1rem; background: #111; color: #eee; }
  a { color: #7ab8ff; }
  .card { border: 1px solid #333; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .card.stop { border-color: #7a2a2a; background: #1c1212; }
  .badge { border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; margin-left: 8px; }
  .badge.ok { background: #1d4022; } .badge.stop { background: #5c1f1f; } .badge.low { background: #3a3a1f; }
  .text { white-space: pre-wrap; }
  .meta { color: #999; font-size: 0.85rem; }
  .reason { color: #ff9c9c; font-size: 0.9rem; margin-top: 0.5rem; }
  .opener { color: #a8d5a8; font-size: 0.9rem; margin-top: 0.5rem; }
  nav a { margin-right: 1rem; }
</style></head><body>
<h1>Bluesky Listening Review</h1>
<p>Read-only monitor output. Every engagement decision is yours, made manually on bsky.app.
Auto-refreshes every 30s. ${counts.shown} shown / ${counts.total} stored (last 3 days), ${counts.doNotEngage} flagged do-not-engage.</p>
<nav>
  <a href="/">All audiences</a>
  <a href="/?audience=research-peptides">research-peptides</a>
  <a href="/?audience=personal-training">personal-training</a>
  <a href="/?all=1">Include low-priority</a>
</nav>
${filtered.map(renderRow).join('\n') || '<p>No matches yet. Is the monitor running? (npm run listen:bluesky)</p>'}
</body></html>`;
}

const app = express();
app.get('/', (req, res) => {
  const entries = loadRecentMatches({ days: 3 });
  res.type('html').send(renderPage(entries, {
    audience: req.query.audience || null,
    showAll: req.query.all === '1'
  }));
});
app.get('/api/matches', (req, res) => {
  res.json(loadRecentMatches({ days: 3 }));
});

app.listen(PORT, () => {
  console.log(`[review] Dashboard on http://localhost:${PORT} (read-only)`);
});

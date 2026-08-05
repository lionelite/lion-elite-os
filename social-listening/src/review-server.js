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
const { analyzeOpportunities, scoreOpportunity, classifyNiche } = require('./opportunity-analysis');

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
  const moneyScore = scoreOpportunity(entry);
  const niche = classifyNiche(post.text, match.audience);
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
  const opportunity = match.doNotEngage
    ? ''
    : `<div class="money">Money score: <strong>${moneyScore}/100</strong> · niche: <strong>${escapeHtml(niche)}</strong></div>`;
  return `
  <article class="card ${match.doNotEngage ? 'stop' : ''}">
    <header>
      <strong>${escapeHtml(match.audience)}</strong> · score ${match.score} · ${escapeHtml(entry.seenAt)} ${badge}
    </header>
    ${opportunity}
    <p class="text">${escapeHtml(post.text)}</p>
    <div class="meta">subject: ${escapeHtml(match.matched.subject.join(', '))} · intent: ${escapeHtml(match.matched.intent.join(', '))}</div>
    ${model}
    ${guidance}
    <a href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Open post on bsky.app →</a>
  </article>`;
}

function renderOpportunitySummary(entries) {
  const analysis = analyzeOpportunities(entries);
  const top = analysis.topOpportunities.slice(0, 5);
  const niches = analysis.niches.slice(0, 8);

  return `
  <section class="panel">
    <h2>Top Money-Making Opportunities</h2>
    <p class="meta">Ranked from public posts surfaced in the last 7 days. Money score combines buying intent, urgency, growth signals, operational complexity, and match quality. It is a prioritization heuristic, not a guarantee of customer value.</p>
    ${top.length ? top.map((entry, index) => `
      <div class="opportunity-row">
        <strong>#${index + 1} · ${entry.opportunity.moneyScore}/100 · ${escapeHtml(entry.opportunity.niche)}</strong>
        <div>${escapeHtml(entry.post.text).slice(0, 260)}</div>
        <div class="meta">lane: ${escapeHtml(entry.match.audience)}</div>
        <a href="${escapeHtml(entry.post.url)}" target="_blank" rel="noopener noreferrer">Review opportunity →</a>
      </div>`).join('') : '<p>No monetizable matches yet.</p>'}
  </section>
  <section class="panel">
    <h2>Best Niches Right Now</h2>
    ${niches.length ? `
      <table>
        <thead><tr><th>Niche</th><th>Leads</th><th>Avg score</th><th>Top score</th></tr></thead>
        <tbody>${niches.map((item) => `<tr><td>${escapeHtml(item.niche)}</td><td>${item.count}</td><td>${item.avgScore}</td><td>${item.topScore}</td></tr>`).join('')}</tbody>
      </table>` : '<p>No niche data yet.</p>'}
  </section>`;
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
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 980px; padding: 0 1rem; background: #111; color: #eee; }
  a { color: #7ab8ff; }
  .card, .panel { border: 1px solid #333; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .card.stop { border-color: #7a2a2a; background: #1c1212; }
  .badge { border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; margin-left: 8px; }
  .badge.ok { background: #1d4022; } .badge.stop { background: #5c1f1f; } .badge.low { background: #3a3a1f; }
  .text { white-space: pre-wrap; }
  .meta { color: #999; font-size: 0.85rem; }
  .reason { color: #ff9c9c; font-size: 0.9rem; margin-top: 0.5rem; }
  .opener { color: #a8d5a8; font-size: 0.9rem; margin-top: 0.5rem; }
  .money { margin: 0.6rem 0; color: #f2d98d; }
  .opportunity-row { border-top: 1px solid #2b2b2b; padding: 0.8rem 0; }
  .opportunity-row:first-of-type { border-top: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.55rem; border-bottom: 1px solid #2b2b2b; }
  nav a { margin-right: 1rem; }
</style></head><body>
<h1>Bluesky Listening Review</h1>
<p>Read-only monitor output. Every engagement decision is yours, made manually on bsky.app.
Auto-refreshes every 30s. ${counts.shown} shown / ${counts.total} stored (last 7 days), ${counts.doNotEngage} flagged do-not-engage.</p>
<nav>
  <a href="/">All audiences</a>
  <a href="/?audience=research-peptides">research-peptides</a>
  <a href="/?audience=personal-training">personal-training</a>
  <a href="/?audience=business-scaling">business-scaling</a>
  <a href="/?all=1">Include low-priority</a>
</nav>
${renderOpportunitySummary(entries)}
<h2>Recent Surfaced Posts</h2>
${filtered.map(renderRow).join('\n') || '<p>No matches yet. Is the monitor running? (npm run listen:bluesky)</p>'}
</body></html>`;
}

const app = express();
app.get('/', (req, res) => {
  const entries = loadRecentMatches({ days: 7 });
  res.type('html').send(renderPage(entries, {
    audience: req.query.audience || null,
    showAll: req.query.all === '1'
  }));
});
app.get('/api/matches', (req, res) => {
  res.json(loadRecentMatches({ days: 7 }));
});
app.get('/api/opportunities', (req, res) => {
  res.json(analyzeOpportunities(loadRecentMatches({ days: 7 })));
});

app.listen(PORT, () => {
  console.log(`[review] Dashboard on http://localhost:${PORT} (read-only)`);
});

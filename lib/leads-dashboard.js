'use strict';

// Server-side renderer for the leads dashboard. Pure function of a leads
// digest (see lib/leads-digest.js) → a self-contained HTML page. Kept
// separate from the data layer so it renders identically against live
// Postgres (executive API /leads route) or a sample digest.

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scoreColor(score) {
  const n = Number(score);
  if (Number.isNaN(n)) return '#9ba3af';
  if (n >= 70) return '#4ade80';
  if (n >= 40) return '#f2d98d';
  return '#f38ba8';
}

function tile(label, value, sub) {
  return `<div class="tile"><div class="tile-value">${escapeHtml(value)}</div>` +
    `<div class="tile-label">${escapeHtml(label)}</div>` +
    `${sub ? `<div class="tile-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="empty">No rows yet.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table>`;
}

function renderLeadsHtml(digest = {}) {
  const prospects = digest.prospects || {};
  const outreach = digest.outreach || {};
  const p = {
    total: prospects.total || 0,
    newToday: prospects.newToday || 0,
    newLast7Days: prospects.newLast7Days || 0,
    suppressed: prospects.suppressed || 0
  };

  const topRows = (prospects.topRated || []).map((row) => `<tr>
    <td>${escapeHtml(row.name || '—')}</td>
    <td><span class="score" style="color:${scoreColor(row.score)}">${row.score == null ? '—' : escapeHtml(row.score)}</span></td>
    <td>${escapeHtml(row.stage || '—')}</td>
    <td>${escapeHtml(row.campaign_id || '—')}</td>
    <td>${escapeHtml(row.created || '—')}</td>
  </tr>`);

  const stageRows = (prospects.byStage || []).map((row) => `<tr>
    <td>${escapeHtml(row.stage || '—')}</td>
    <td>${escapeHtml(row.count)}</td>
    <td><span class="score" style="color:${scoreColor(row.avg_score)}">${row.avg_score == null ? '—' : escapeHtml(row.avg_score)}</span></td>
  </tr>`);

  const campaignRows = (prospects.byCampaignLast7Days || []).map((row) => `<tr>
    <td>${escapeHtml(row.campaign_id || '—')}</td>
    <td>${escapeHtml(row.count)}</td>
    <td><span class="score" style="color:${scoreColor(row.avg_score)}">${row.avg_score == null ? '—' : escapeHtml(row.avg_score)}</span></td>
  </tr>`);

  const queueRows = (outreach.queueByStatus || []).map((row) => `<tr>
    <td>${escapeHtml(row.status || '—')}</td><td>${escapeHtml(row.count)}</td>
  </tr>`);

  const sentRows = (outreach.sentByDay || []).map((row) => `<tr>
    <td>${escapeHtml(row.day || '—')}</td><td>${escapeHtml(row.channel || '—')}</td><td>${escapeHtml(row.sent)}</td>
  </tr>`);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lion Elite — Leads Dashboard</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f1115; color: #e7e9ee; margin: 0; padding: 24px; }
  .wrap { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 2px; } .sub { color: #9ba3af; font-size: 0.85rem; margin: 0 0 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 26px; }
  .tile { background: #16191f; border: 1px solid #262b33; border-radius: 12px; padding: 16px; }
  .tile-value { font-size: 2rem; font-weight: 700; } .tile-label { color: #9ba3af; font-size: 0.8rem; text-transform: uppercase; letter-spacing: .04em; }
  .tile-sub { color: #6b7280; font-size: 0.75rem; margin-top: 4px; }
  h2 { font-size: 1rem; margin: 26px 0 10px; color: #cbd2dc; }
  table { width: 100%; border-collapse: collapse; background: #16191f; border: 1px solid #262b33; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #21262e; font-size: 0.9rem; }
  th { color: #9ba3af; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: .04em; }
  tr:last-child td { border-bottom: 0; } .score { font-weight: 700; } .empty { color: #6b7280; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; } @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
</style></head><body><div class="wrap">
  <h1>Leads Dashboard</h1>
  <p class="sub">Generated ${escapeHtml(digest.generatedAt || '—')}${digest.sample ? ' · SAMPLE DATA (not connected to production)' : ''}</p>
  <div class="tiles">
    ${tile('Total prospects', p.total)}
    ${tile('New today', p.newToday)}
    ${tile('New (7 days)', p.newLast7Days)}
    ${tile('Suppressed', p.suppressed)}
  </div>
  <h2>Top rated leads</h2>
  ${table(['Business', 'Score', 'Stage', 'Campaign', 'Added'], topRows)}
  <div class="cols">
    <div><h2>By stage</h2>${table(['Stage', 'Count', 'Avg score'], stageRows)}</div>
    <div><h2>By campaign (7 days)</h2>${table(['Campaign', 'Count', 'Avg score'], campaignRows)}</div>
  </div>
  <div class="cols">
    <div><h2>Outreach queue</h2>${table(['Status', 'Count'], queueRows)}</div>
    <div><h2>Emails sent (7 days)</h2>${table(['Day', 'Channel', 'Sent'], sentRows)}</div>
  </div>
</div></body></html>`;
}

module.exports = { renderLeadsHtml, escapeHtml };

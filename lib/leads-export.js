'use strict';

// Sanitized leads export. Turns a leads digest (lib/leads-digest.js) into
// an aggregate summary safe to store as a CI artifact: counts, score
// distribution, stage/campaign breakdowns, and top leads with names and
// emails REDACTED. Business names/emails never leave the authenticated
// dashboard (repo privacy rule, PR #46 — no customer snapshots in GitHub).

function scoreBucket(score) {
  if (score == null || score === '') return 'unscored';
  const n = Number(score);
  if (Number.isNaN(n)) return 'unscored';
  if (n >= 70) return 'strong_70_plus';
  if (n >= 40) return 'medium_40_69';
  return 'weak_0_39';
}

// Redact a business name to a non-identifying initialism (e.g. "Legacy
// Fit" -> "L.F."). Enough to tell rows apart, not enough to identify.
function redactName(name) {
  const initials = String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('.');
  return initials ? `${initials}.` : '—';
}

function scoreDistribution(topRated = []) {
  const dist = { strong_70_plus: 0, medium_40_69: 0, weak_0_39: 0, unscored: 0 };
  for (const row of topRated) dist[scoreBucket(row.score)] += 1;
  return dist;
}

/**
 * Produce a PII-free view of a digest. Aggregate tables pass through
 * (they carry no PII); topRated is stripped of name/email and keeps only
 * initials + score/stage/campaign/date so the export can be shared/analyzed
 * without exposing customer identities.
 */
function sanitizeDigest(digest = {}) {
  const prospects = digest.prospects || {};
  const outreach = digest.outreach || {};
  const topRated = (prospects.topRated || []).map((row, i) => ({
    rank: i + 1,
    initials: redactName(row.name),
    score: row.score ?? null,
    stage: row.stage || null,
    campaign: row.campaign_id || row.campaign || null,
    added: row.created || null
  }));

  return {
    generatedAt: digest.generatedAt || new Date().toISOString(),
    sanitized: true,
    prospects: {
      total: prospects.total || 0,
      newToday: prospects.newToday || 0,
      newLast7Days: prospects.newLast7Days || 0,
      suppressed: prospects.suppressed || 0,
      byStage: prospects.byStage || [],
      byCampaignLast7Days: prospects.byCampaignLast7Days || [],
      scoreDistribution: scoreDistribution(prospects.topRated),
      topRatedRedacted: topRated
    },
    outreach: {
      queueByStatus: outreach.queueByStatus || [],
      sentByDay: outreach.sentByDay || []
    }
  };
}

function table(rows, cols) {
  if (!rows.length) return '_none_\n';
  const header = `| ${cols.map((c) => c.label).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${cols.map((c) => r[c.key] ?? '—').join(' | ')} |`).join('\n');
  return `${header}\n${sep}\n${body}\n`;
}

function renderSummaryMarkdown(sanitized) {
  const p = sanitized.prospects;
  const d = p.scoreDistribution;
  return [
    `# Leads Export (sanitized) — ${sanitized.generatedAt}`,
    '',
    `**Total prospects:** ${p.total}  ·  **New today:** ${p.newToday}  ·  **New (7d):** ${p.newLast7Days}  ·  **Suppressed:** ${p.suppressed}`,
    '',
    `**Score distribution (top leads):** strong(≥70) ${d.strong_70_plus} · medium(40–69) ${d.medium_40_69} · weak(<40) ${d.weak_0_39} · unscored ${d.unscored}`,
    '',
    '## By stage',
    table(p.byStage, [{ key: 'stage', label: 'Stage' }, { key: 'count', label: 'Count' }, { key: 'avg_score', label: 'Avg score' }]),
    '## By campaign (7 days)',
    table(p.byCampaignLast7Days, [{ key: 'campaign_id', label: 'Campaign' }, { key: 'count', label: 'Count' }, { key: 'avg_score', label: 'Avg score' }]),
    '## Top leads (identities redacted — look up in the dashboard)',
    table(p.topRatedRedacted, [
      { key: 'rank', label: '#' }, { key: 'initials', label: 'Initials' }, { key: 'score', label: 'Score' },
      { key: 'stage', label: 'Stage' }, { key: 'campaign', label: 'Campaign' }, { key: 'added', label: 'Added' }
    ]),
    '## Outreach',
    table(sanitized.outreach.queueByStatus, [{ key: 'status', label: 'Queue status' }, { key: 'count', label: 'Count' }]),
    table(sanitized.outreach.sentByDay, [{ key: 'day', label: 'Day' }, { key: 'channel', label: 'Channel' }, { key: 'sent', label: 'Sent' }]),
    '',
    '_Names and emails are intentionally omitted. See the authenticated /leads dashboard for identities._'
  ].join('\n');
}

// FULL detail (names + emails). For LOCAL / private-run use only — never
// for the public repo or a CI artifact (the script blocks --full in CI).
function renderFullMarkdown(digest = {}) {
  const p = digest.prospects || {};
  const rows = (p.topRated || []).map((r, i) =>
    `| ${i + 1} | ${r.name || '—'} | ${r.email || '—'} | ${r.score ?? '—'} | ${r.stage || '—'} | ${r.campaign_id || r.campaign || '—'} | ${r.created || '—'} |`
  ).join('\n');
  return [
    `# Leads Export (FULL — contains PII, keep private) — ${digest.generatedAt || new Date().toISOString()}`,
    '',
    `Total ${p.total || 0} · new today ${p.newToday || 0} · new 7d ${p.newLast7Days || 0} · suppressed ${p.suppressed || 0}`,
    '',
    '| # | Business | Email | Score | Stage | Campaign | Added |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows || '_no leads_',
    '',
    '_Contains names and emails. Do not commit, upload, or paste into any public or shared location._'
  ].join('\n');
}

module.exports = { scoreBucket, redactName, scoreDistribution, sanitizeDigest, renderSummaryMarkdown, renderFullMarkdown };

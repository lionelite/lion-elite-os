'use strict';

const fs = require('fs');
const path = require('path');
const { loadRecentMatches } = require('../social-listening/src/store');
const { classifyUniversalLead } = require('../social-listening/src/universal-lead-intelligence');

const OUT_DIR = path.join(process.cwd(), 'claude-context');
const OUT_FILE = path.join(OUT_DIR, 'bluesky-leads.json');

function normalizeLocalEntry(entry) {
  const post = entry?.post || {};
  const universal = classifyUniversalLead(post.text || '');
  const score = Number(entry?.match?.score || universal?.opportunityScore || 0);
  const niche = universal?.niche || entry?.match?.audience || 'Other / Emerging Opportunity';
  return {
    source: 'local-jsonl',
    score,
    niche,
    postText: post.text || '',
    postUrl: post.url || null,
    did: post.did || null,
    rkey: post.rkey || null,
    createdAt: post.createdAt || null,
    seenAt: entry?.seenAt || null,
    doNotEngage: Boolean(entry?.match?.doNotEngage),
    intentSignals: universal?.intentSignals || entry?.match?.matched?.intent || [],
    valueSignals: universal?.valueSignals || [],
    audience: entry?.match?.audience || null
  };
}

async function fromPostgres() {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { buildBlueskyLeadReport } = require('../lib/bluesky-lead-report');
    const report = await buildBlueskyLeadReport({ limit: 500 });
    return {
      source: 'postgresql',
      generatedAt: report.generatedAt,
      totalLeads: report.totalLeads,
      niches: report.niches,
      leads: report.topLeads
    };
  } catch (error) {
    console.warn(`[claude:bluesky] PostgreSQL unavailable: ${error.message}`);
    return null;
  }
}

function fromLocal() {
  const entries = loadRecentMatches({ days: Number(process.env.CLAUDE_BLUESKY_DAYS || 30) });
  const leads = entries
    .map(normalizeLocalEntry)
    .filter(lead => lead.postText)
    .sort((a, b) => b.score - a.score);

  const byNiche = new Map();
  for (const lead of leads) {
    const current = byNiche.get(lead.niche) || { niche: lead.niche, leadCount: 0, totalScore: 0, topScore: 0 };
    current.leadCount += 1;
    current.totalScore += lead.score;
    current.topScore = Math.max(current.topScore, lead.score);
    byNiche.set(lead.niche, current);
  }
  const niches = [...byNiche.values()]
    .map(n => ({ ...n, averageScore: n.leadCount ? Math.round(n.totalScore / n.leadCount) : 0 }))
    .sort((a, b) => (b.averageScore * b.leadCount) - (a.averageScore * a.leadCount));

  return {
    source: 'local-jsonl',
    generatedAt: new Date().toISOString(),
    totalLeads: leads.length,
    niches,
    leads: leads.slice(0, 500)
  };
}

async function main() {
  const snapshot = (await fromPostgres()) || fromLocal();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`[claude:bluesky] source=${snapshot.source} leads=${snapshot.totalLeads}`);
  console.log(`[claude:bluesky] wrote ${OUT_FILE}`);
  const top = snapshot.leads.slice(0, 10);
  for (const [index, lead] of top.entries()) {
    console.log(`${index + 1}. ${lead.score || 0}/100 | ${lead.niche || 'Other'} | ${(lead.postText || '').replace(/\s+/g, ' ').slice(0, 140)}`);
  }
}

main().catch(error => {
  console.error(`[claude:bluesky] FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});

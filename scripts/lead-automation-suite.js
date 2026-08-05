'use strict';

const express = require('express');
const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
const { buildBlueskyLeadReport, CAMPAIGN_ID } = require('../lib/bluesky-lead-report');

const store = new PostgresProspectStore();
const PUBLIC_BSKY = 'https://public.api.bsky.app';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function extractUrls(text = '') { return [...new Set(String(text).match(/https?:\/\/[^\s)]+/gi) || [])].slice(0, 5); }

async function getUniversalProspects() {
  return store.list({ campaignId: CAMPAIGN_ID, status: 'active' });
}

async function enrichOne(prospect) {
  const did = prospect.business?.sourceDid || prospect.contact?.blueskyDid;
  if (!did) return { updated: false, reason: 'NO_DID' };
  const url = `${PUBLIC_BSKY}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) return { updated: false, reason: `PROFILE_${response.status}` };
  const profile = await response.json();
  const description = profile.description || '';
  const enrichment = {
    ...(prospect.enrichment || {}),
    blueskyProfile: {
      did: profile.did,
      handle: profile.handle,
      displayName: profile.displayName || null,
      description,
      followersCount: profile.followersCount || 0,
      followsCount: profile.followsCount || 0,
      postsCount: profile.postsCount || 0,
      avatar: profile.avatar || null,
      profileUrl: `https://bsky.app/profile/${profile.handle || did}`,
      externalUrls: extractUrls(description),
      enrichedAt: new Date().toISOString()
    }
  };
  const business = {
    ...(prospect.business || {}),
    displayName: profile.displayName || prospect.business?.displayName || profile.handle || did,
    blueskyHandle: profile.handle || null,
    profileDescription: description,
    profileUrl: `https://bsky.app/profile/${profile.handle || did}`,
    externalUrls: extractUrls(description)
  };
  await store.update(prospect.prospectId, { business, enrichment }, 'bluesky-enrichment-worker');
  return { updated: true };
}

async function runEnrichmentCycle() {
  const prospects = await getUniversalProspects();
  const candidates = prospects
    .filter(p => Number(p.score || 0) >= Number(process.env.LEAD_ENRICH_MIN_SCORE || 55))
    .filter(p => !p.enrichment?.blueskyProfile?.enrichedAt || Date.now() - Date.parse(p.enrichment.blueskyProfile.enrichedAt) > 86400000)
    .slice(0, Number(process.env.LEAD_ENRICH_BATCH_SIZE || 25));
  let updated = 0;
  for (const prospect of candidates) {
    try { if ((await enrichOne(prospect)).updated) updated += 1; }
    catch (error) { console.error('[lead-enrich]', prospect.prospectId, error.message); }
  }
  console.log(`[lead-enrich] candidates=${candidates.length} updated=${updated}`);
}

function routeFor(prospect) {
  const campaign = String(prospect.campaignId || '');
  const business = prospect.business || {};
  const score = Number(prospect.score || 0);
  if (campaign === CAMPAIGN_ID) return score >= 70 ? 'review_high_priority_bluesky_lead' : 'monitor_bluesky_lead';
  if (/affiliate|wholesale|partner/i.test(campaign)) return 'partnership_pipeline';
  if (/customer|order|reactivation|retention/i.test(campaign)) return 'customer_followup';
  if (business.email || prospect.contact?.email) return score >= 70 ? 'email_outreach_candidate' : 'nurture_public_business_lead';
  return 'research_contact_path';
}

async function runRoutingCycle() {
  const prospects = await store.list({ status: 'active' });
  let changed = 0;
  for (const prospect of prospects) {
    const nextAction = routeFor(prospect);
    if (prospect.nextAction === nextAction) continue;
    await store.update(prospect.prospectId, { nextAction }, 'unified-lead-router');
    changed += 1;
  }
  console.log(`[lead-router] scanned=${prospects.length} routed=${changed}`);
}

function buildDigestText(report) {
  const today = new Date().toISOString().slice(0, 10);
  const leads = report.topLeads.slice(0, 10);
  const niches = report.niches.slice(0, 5);
  return [
    `LionOS Daily Bluesky Opportunity Digest — ${today}`,
    `Total stored leads: ${report.totalLeads}`,
    '',
    'Top niches:',
    ...niches.map((n, i) => `${i + 1}. ${n.niche} — ${n.leadCount} leads — opportunity index ${n.opportunityIndex}/100`),
    '',
    'Top 10 leads:',
    ...leads.map((l, i) => `${i + 1}. ${l.score}/100 | ${l.niche}\n${l.postText || ''}\n${l.postUrl || l.profileUrl || ''}`)
  ].join('\n');
}

async function sendDigestEmail(text) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_DIGEST_TO;
  const from = process.env.OUTREACH_FROM_EMAIL;
  if (!apiKey || !to || !from) return { sent: false, reason: 'EMAIL_ENV_NOT_CONFIGURED' };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: 'LionOS Daily Lead Opportunity Digest', text }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Resend ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return { sent: true };
}

async function runDigest() {
  const report = await buildBlueskyLeadReport({ limit: 10 });
  const text = buildDigestText(report);
  console.log(text);
  const email = await sendDigestEmail(text);
  console.log('[lead-digest]', email);
}

function renderDashboard(report) {
  const leads = report.topLeads.slice(0, 50);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LionOS Lead Intelligence</title><style>body{font-family:system-ui;background:#0d0d0d;color:#eee;max-width:1200px;margin:0 auto;padding:24px}a{color:#8bc5ff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{background:#171717;border:1px solid #333;border-radius:10px;padding:14px;margin:12px 0}.score{font-size:24px;font-weight:700}.meta{color:#aaa;font-size:13px}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #333;padding:8px}</style></head><body><h1>LionOS Lead Intelligence</h1><p>${report.totalLeads} stored Bluesky leads · updated ${esc(report.generatedAt)}</p><h2>Best niches right now</h2><table><tr><th>Niche</th><th>Leads</th><th>Avg</th><th>Top</th><th>Index</th></tr>${report.niches.slice(0,20).map(n=>`<tr><td>${esc(n.niche)}</td><td>${n.leadCount}</td><td>${n.averageScore}</td><td>${n.topScore}</td><td>${n.opportunityIndex}</td></tr>`).join('')}</table><h2>Highest-value leads</h2>${leads.map(l=>`<div class="card"><div class="score">${l.score}/100</div><strong>${esc(l.niche)}</strong><p>${esc(l.postText || '')}</p><div class="meta">${esc(l.sourceDid || '')}</div>${l.postUrl?`<a href="${esc(l.postUrl)}" target="_blank" rel="noopener">Open source post</a>`:''}</div>`).join('')}</body></html>`;
}

async function startApi() {
  const app = express();
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'lion-elite-lead-intelligence', timestamp: new Date().toISOString() }));
  app.get('/api/leads', async (req, res, next) => { try { res.json(await buildBlueskyLeadReport({ limit: Number(req.query.limit || 100) })); } catch (e) { next(e); } });
  app.get('/api/niches', async (req, res, next) => { try { const r = await buildBlueskyLeadReport({ limit: 1 }); res.json({ niches: r.niches, totalLeads: r.totalLeads, generatedAt: r.generatedAt }); } catch (e) { next(e); } });
  app.get('/', async (req, res, next) => { try { res.type('html').send(renderDashboard(await buildBlueskyLeadReport({ limit: 50 }))); } catch (e) { next(e); } });
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message }); });
  const port = Number(process.env.PORT || 4700);
  app.listen(port, () => console.log(`[lead-api] listening on ${port}`));
}

async function loop(name, fn, intervalMs) {
  console.log(`[${name}] started interval=${intervalMs}ms`);
  while (true) {
    try { await fn(); } catch (error) { console.error(`[${name}]`, error.stack || error.message); }
    await sleep(intervalMs);
  }
}

async function main() {
  const mode = process.argv[2] || 'api';
  if (mode === 'api') return startApi();
  if (mode === 'enrich') return loop('lead-enrich', runEnrichmentCycle, Number(process.env.LEAD_ENRICH_INTERVAL_MS || 900000));
  if (mode === 'route') return loop('lead-router', runRoutingCycle, Number(process.env.LEAD_ROUTER_INTERVAL_MS || 120000));
  if (mode === 'digest') return runDigest();
  throw new Error(`Unknown mode: ${mode}`);
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

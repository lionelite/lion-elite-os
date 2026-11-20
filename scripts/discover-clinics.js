#!/usr/bin/env node
'use strict';

/**
 * Clinic discovery, run on the GitHub Actions runner every two hours
 * (.github/workflows/clinic-discovery.yml). Separate from sending.
 *
 *   1. POST /run/clinic-discovery/state  → today's stored count, the 200/day
 *      target, the metro cursor, the 50 metros, the User-Agent to send.
 *   2. Per metro, from the cursor, until the day's target is stored or the time
 *      budget is spent:
 *        a. one Overpass query (90 s, rotating mirrors, backoff)
 *        b. drop excluded trades and listings clinic-targeting rates low
 *        c. POST /known — skip sites already on record or crawled with no e-mail
 *        d. crawl home + contact/about/team for business e-mail, phone, leader
 *        e. POST /store — the service dedupes and writes to Supabase
 *   3. POST /log with per-metro and total counts; same numbers to the job summary.
 *
 * Env: SERVICE_URL; OUTREACH_SECRET, or the Actions OIDC request variables
 * (a fresh token is fetched per call — they expire in minutes).
 * Optional: DISCOVERY_BUDGET_MINUTES (100), DISCOVERY_MAX_CRAWLS_PER_METRO (150),
 * DISCOVERY_CRAWL_CONCURRENCY (10), DISCOVERY_MAX_METROS (all).
 *
 * --dry-run: no service calls; searches DISCOVERY_MAX_METROS metros (default 2)
 * from the first and prints what it would store.
 */

const fs = require('fs');
const { DEFAULT_AREAS } = require('../lib/discovery/discovery-run');
const { fetchClinicListings } = require('../lib/discovery/clinic-overpass');
const { crawlClinicSite, judgeEmail, mapPool } = require('../lib/discovery/clinic-site-crawl');
const { clinicRelevance } = require('../lib/contacts/clinic-targeting');
const { normalizeDomain } = require('../lib/email-enrichment');
const { discoveryUserAgent } = require('../lib/discovery/osm-source');

const DRY_RUN = process.argv.includes('--dry-run');
const SERVICE_URL = String(process.env.SERVICE_URL || '').replace(/\/$/, '');
const BUDGET_MS = Number(process.env.DISCOVERY_BUDGET_MINUTES || 100) * 60_000;
const MAX_CRAWLS = Number(process.env.DISCOVERY_MAX_CRAWLS_PER_METRO || 150);
const CONCURRENCY = Number(process.env.DISCOVERY_CRAWL_CONCURRENCY || 10);
const MAX_METROS = Number(process.env.DISCOVERY_MAX_METROS || (DRY_RUN ? 2 : 0)) || Infinity;
const METRO_SPACING_MS = 3000;

let cachedToken = null;
async function authHeaders() {
  if (process.env.OUTREACH_SECRET) return { 'x-outreach-secret': process.env.OUTREACH_SECRET };
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env;
  if (!url || !bearer) throw new Error('Set OUTREACH_SECRET, or run in Actions with id-token: write.');
  if (!cachedToken || Date.now() - cachedToken.at > 3 * 60_000) {
    const response = await fetch(`${url}&audience=lion-elite-os-cron`, { headers: { authorization: `bearer ${bearer}` } });
    if (!response.ok) throw new Error(`OIDC token request → HTTP ${response.status}`);
    cachedToken = { value: (await response.json()).value, at: Date.now() };
  }
  return { authorization: `Bearer ${cachedToken.value}` };
}

async function post(path, body, { attempts = 3 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${SERVICE_URL}${path}`, {
        method: 'POST',
        headers: { ...(await authHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000)
      });
      const json = await response.json().catch(() => ({}));
      if (response.ok) return json;
      lastError = new Error(`${path} → HTTP ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
      if (response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise(r => setTimeout(r, 5000 * (i + 1)));
  }
  throw lastError;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const add = (target, source) => { for (const [k, v] of Object.entries(source || {})) target[k] = (target[k] || 0) + v; };

async function main() {
  const startedAt = new Date();
  const deadline = Date.now() + BUDGET_MS;
  const state = DRY_RUN
    ? { date: startedAt.toISOString().slice(0, 10), storedToday: 0, target: 200, cursor: 0, areas: DEFAULT_AREAS, userAgent: discoveryUserAgent() }
    : await post('/run/clinic-discovery/state', {});
  const areas = state.areas;
  console.log(`[discover] ${state.date}: ${state.storedToday}/${state.target} stored today; starting at metro ${state.cursor} (${areas[state.cursor].label}) of ${areas.length}${DRY_RUN ? ' [dry run]' : ''}`);

  const totals = { queried: 0, queryFailed: 0, found: 0, withWebsite: 0, excludedTrade: 0, notTargeted: 0, alreadyKnown: 0,
    crawled: 0, siteUnreachable: 0, withEmail: 0, personalRefused: 0, withPhone: 0, withLeader: 0, stored: 0, duplicates: 0, refusedByService: {} };
  const metros = [];
  let storedToday = state.storedToday;
  let stopReason = 'all metros searched';

  for (let step = 0; step < areas.length; step += 1) {
    if (storedToday >= state.target) { stopReason = `daily target reached (${storedToday}/${state.target})`; break; }
    if (Date.now() > deadline) { stopReason = 'time budget spent'; break; }
    if (step >= MAX_METROS) { stopReason = `metro limit ${MAX_METROS}`; break; }
    const index = (state.cursor + step) % areas.length;
    const area = areas[index];
    const m = { area: area.label, queried: 1, found: 0, withWebsite: 0, targeted: 0, known: 0, crawled: 0, withEmail: 0, stored: 0, error: null };
    totals.queried += 1;
    if (step > 0) await sleep(METRO_SPACING_MS);

    let listings;
    try {
      const answer = await fetchClinicListings({ area, rotation: index, userAgent: state.userAgent, logger: { warn: s => console.log(`[discover]   ${s}`) } });
      listings = answer.listings;
      m.found = answer.counts.named;
      m.withWebsite = answer.counts.withWebsite;
      m.mirror = new URL(answer.mirror).hostname;
      totals.excludedTrade += Object.values(answer.excluded).reduce((a, b) => a + b, 0);
    } catch (error) {
      m.error = error.message;
      totals.queryFailed += 1;
      metros.push(m);
      console.log(`[discover] ${area.label}: ${error.message} [${(error.attempts || []).map(a => `${new URL(a.mirror).hostname}:${a.outcome}`).join(', ')}]`);
      continue;
    }
    totals.found += m.found;
    totals.withWebsite += m.withWebsite;

    // Targeting first, so the crawl budget goes to clinics that could be sent to.
    const ranked = listings
      .map(l => ({ ...l, tier: clinicRelevance({ name: l.name, website: l.website, category: l.category }).tier }))
      .filter(l => { if (l.tier === 'high' || l.tier === 'medium') return true; totals.notTargeted += 1; return false; })
      .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'high' ? -1 : 1));
    // One crawl per site even when a chain lists several branches.
    const bySite = new Map();
    for (const l of ranked) { const d = normalizeDomain(l.website); if (d && !bySite.has(d)) bySite.set(d, l); }
    m.targeted = bySite.size;

    let skip = { known: [], noEmailRecently: [] };
    if (!DRY_RUN && bySite.size) skip = await post('/run/clinic-discovery/known', { domains: [...bySite.keys()] });
    const skipSet = new Set([...skip.known, ...skip.noEmailRecently]);
    const toCrawl = [...bySite.entries()].filter(([d]) => !skipSet.has(d)).map(([, l]) => l).slice(0, MAX_CRAWLS);
    m.known = bySite.size - [...bySite.keys()].filter(d => !skipSet.has(d)).length;
    totals.alreadyKnown += m.known;

    const crawled = await mapPool(toCrawl, CONCURRENCY, async listing => ({ listing, site: await crawlClinicSite({ website: listing.website, userAgent: state.userAgent }) }));
    const candidates = [];
    const noEmailDomains = [];
    for (const { listing, site } of crawled) {
      m.crawled += 1;
      if (!site.ok) { totals.siteUnreachable += 1; continue; }
      totals.personalRefused += site.refused.personal_webmail || 0;
      let email = site.email;
      let emailSource = site.emailSource;
      // The listing's own e-mail tag, when the site shows none and it is on the clinic's domain.
      if (!email && listing.email && judgeEmail(listing.email.toLowerCase(), [site.domain, normalizeDomain(listing.website)]).ok) {
        email = listing.email.toLowerCase();
        emailSource = `https://www.openstreetmap.org/${listing.sourceRef}`;
      }
      if (!email) { noEmailDomains.push(site.domain); continue; }
      m.withEmail += 1;
      if (site.phone || listing.phone) totals.withPhone += 1;
      if (site.leader) totals.withLeader += 1;
      candidates.push({
        name: listing.name, category: listing.category, website: site.website || listing.website, email, emailSource,
        phone: site.phone || listing.phone, phoneSource: site.phone ? site.phoneSource : null, address: listing.address,
        speciality: listing.speciality, osmTag: listing.osmTag, sourceRef: listing.sourceRef, leader: site.leader, signals: site.signals
      });
    }
    totals.crawled += m.crawled;
    totals.withEmail += m.withEmail;

    if (DRY_RUN) {
      console.log(`[discover]   would store ${candidates.length}: ${candidates.slice(0, 8).map(c => `${c.name} <${c.email}>${c.leader ? ` (${c.leader.role}: ${c.leader.name})` : ''}`).join('; ')}`);
    } else {
      const stored = await post('/run/clinic-discovery/store', { area: area.label, areaIndex: index, candidates, noEmailDomains });
      m.stored = stored.stored;
      totals.stored += stored.stored;
      totals.duplicates += stored.duplicates;
      add(totals.refusedByService, stored.refused);
      storedToday = stored.storedToday;
    }
    metros.push(m);
    console.log(`[discover] ${area.label}: queried 1 (${m.mirror}), found ${m.found}, with website ${m.withWebsite}, targeted ${m.targeted}, already known ${m.known}, crawled ${m.crawled}, with email ${m.withEmail}, stored ${m.stored} → today ${storedToday}/${state.target}`);
  }

  const line = `[discover] RUN ${stopReason}: queried ${totals.queried} (failed ${totals.queryFailed}), found ${totals.found}, with website ${totals.withWebsite}, `
    + `with email ${totals.withEmail}, stored ${totals.stored} | crawled ${totals.crawled}, unreachable ${totals.siteUnreachable}, already known ${totals.alreadyKnown}, `
    + `not targeted ${totals.notTargeted}, excluded trades ${totals.excludedTrade}, webmail refused ${totals.personalRefused}, duplicates ${totals.duplicates}, `
    + `with phone ${totals.withPhone}, with owner/director ${totals.withLeader}; today ${storedToday}/${state.target}`;
  console.log(line);

  if (!DRY_RUN) {
    const logged = await post('/run/clinic-discovery/log', { totals: { ...totals, stopReason }, metros, startedAt: startedAt.toISOString() }).catch(e => ({ error: e.message }));
    if (logged.error) console.log(`::warning::run log not stored: ${logged.error}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = metros.map(x => `| ${x.area} | ${x.error ? 'failed' : x.queried} | ${x.found} | ${x.withWebsite} | ${x.withEmail} | ${x.stored} | ${x.error ? x.error.slice(0, 80) : ''} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `## Clinic discovery — ${state.date}`, '',
      `**${stopReason}.** Stored today: **${storedToday} / ${state.target}**`, '',
      '| | queried | found | with website | with email | stored |', '|---|---|---|---|---|---|',
      `| **total** | ${totals.queried} | ${totals.found} | ${totals.withWebsite} | ${totals.withEmail} | ${totals.stored} |`, '',
      '| metro | queried | found | with website | with email | stored | error |', '|---|---|---|---|---|---|---|', ...rows, '',
      '```', line, '```', ''
    ].join('\n'));
  }
  // Nothing at all answered: say so with a failing job, not a quiet zero.
  if (totals.queried > 0 && totals.queryFailed === totals.queried) process.exitCode = 1;
}

main().catch(error => {
  console.error(`::error::clinic discovery failed: ${error.message}`);
  process.exitCode = 1;
});

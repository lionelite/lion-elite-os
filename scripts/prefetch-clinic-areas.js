#!/usr/bin/env node
'use strict';

/**
 * Run on the GitHub Actions runner before each clinic outreach batch.
 *
 * Render's free web service shares egress IPs that overpass-api.de refuses
 * (ECONNREFUSED), that the other Overpass mirrors time out on, and that
 * Nominatim answers with 429 — so discovery found nothing there. The runner's
 * network can reach Overpass, so it does the map search and uploads the
 * answers into the service's per-day cache (Supabase discovery_area_cache).
 * The service then reads those metros instead of querying the map itself.
 *
 *   1. POST /run/clinic-outreach/plan   → the next metros + the User-Agent to send
 *   2. Overpass, per metro: clinic + med-spa listings that carry a website tag
 *   3. POST /run/clinic-outreach/areas  → one metro per request
 *
 * Env: SERVICE_URL, and OUTREACH_SECRET or OIDC_TOKEN. PREFETCH_AREAS (default 6).
 * Never fails the job: a metro that cannot be fetched is left for the service.
 */

const { fetchBusinessesByCategory } = require('../lib/discovery/osm-source');

const SERVICE_URL = String(process.env.SERVICE_URL || '').replace(/\/$/, '');
const COUNT = Number(process.env.PREFETCH_AREAS || 6);

function authHeaders() {
  if (process.env.OUTREACH_SECRET) return { 'x-outreach-secret': process.env.OUTREACH_SECRET };
  if (process.env.OIDC_TOKEN) return { authorization: `Bearer ${process.env.OIDC_TOKEN}` };
  throw new Error('Set OUTREACH_SECRET or OIDC_TOKEN.');
}

async function post(path, body) {
  const response = await fetch(`${SERVICE_URL}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  if (!SERVICE_URL) throw new Error('SERVICE_URL is required.');
  const plan = await post('/run/clinic-outreach/plan', { count: COUNT });
  console.log(`[prefetch] ${plan.date}: ${plan.areas.length} metro(s) to search from rotation ${plan.rotation}: ${plan.areas.map(a => a.label).join(', ') || '(all cached today)'}`);
  let uploaded = 0;
  for (const area of plan.areas) {
    let result;
    try {
      result = await fetchBusinessesByCategory({
        area, categories: ['med-spa', 'clinic'], websiteOnly: true, userAgent: plan.userAgent, timeoutMs: 60_000,
        logger: { warn: m => console.log(`[prefetch]   ${m}`), log: () => {} },
      });
    } catch (error) {
      console.log(`[prefetch] ${area.label}: Overpass unreachable from the runner too (${error.message}); left for the service`);
      continue;
    }
    const stored = await post('/run/clinic-outreach/areas', {
      areas: [{ label: area.label, businesses: result.businesses, failures: result.failures }],
    });
    uploaded += 1;
    const s = stored.stored[0] || {};
    console.log(`[prefetch] ${area.label}: ${result.businesses.length} listing(s) with a website${result.failures.length ? ` (unreachable: ${result.failures.map(f => f.category).join('/')})` : ''} → ${s.inserted ? 'cached' : 'already cached today'}`);
  }
  console.log(`[prefetch] done: ${uploaded}/${plan.areas.length} metro(s) uploaded`);
}

main().catch(error => {
  // Prefetch is an optimisation: the batch still runs (and says what it could not reach).
  console.log(`::warning::prefetch failed: ${error.message}`);
});

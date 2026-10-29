#!/usr/bin/env node
'use strict';

/**
 * Find a published contact e-mail for admitted leads that have a website but
 * no address, and write it back into the lead store.
 *
 * Why this exists as its own pass rather than only inside the harvest: the
 * harvest enriches a lead once, at the moment it is discovered. A site that
 * was slow, behind Cloudflare, or simply not yet built that day never gets a
 * second look, and the lead sits in the store with a phone number forever.
 * The live store proved the point — 52 admitted leads carry a website and no
 * e-mail, which is more contactable businesses than the whole sendable list.
 *
 * **This cannot run in the Claude dev sandbox.** Its egress proxy refuses
 * arbitrary hosts (`connect_rejected` for every clinic domain tried), and
 * Node's built-in fetch does not honour HTTPS_PROXY in any case. It runs on
 * the GitHub runner, where outbound access exists — same reason the harvest
 * lives there. Running it locally will report every site as unreachable, which
 * is a sandbox fact and not a fact about the businesses.
 *
 * Only a business's OWN published address is taken. No data broker, no
 * guessed pattern, no personal inbox: `lib/email-enrichment.js` scores
 * candidates and this pass takes only what clears its confidence bar.
 */

const fs = require('fs');
const path = require('path');
const { enrichBusinessEmail } = require('../lib/email-enrichment');
const { clinicRelevance, TIER_ORDER } = require('../lib/contacts/clinic-targeting');

const STORE = path.join(__dirname, '..', 'leads', 'harvested', 'leads.jsonl');
const CATEGORIES = ['med-spa', 'clinic'];

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function categoryOf(lead) {
  const subjects = (lead.matchedTerms || {}).subject || [];
  return subjects[0] || String(lead.matchedQuery || '').split('/')[1] || '';
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function main() {
  if (!fs.existsSync(STORE)) {
    console.error(`No lead store at ${STORE}.`);
    console.error('  git show origin/automation/leads:leads/harvested/leads.jsonl > leads/harvested/leads.jsonl');
    process.exit(1);
  }

  const limit = Number(arg('limit', '40'));
  const minTier = arg('tier', 'medium');
  const dryRun = process.argv.includes('--dry-run');

  const lines = fs.readFileSync(STORE, 'utf8').split('\n').filter(Boolean);
  const leads = lines.map(line => JSON.parse(line));

  // Only leads this campaign is allowed to contact are worth the fetch. Running
  // enrichment on an excluded practice would be spending requests to build a
  // contact record we must never use.
  const targets = leads.filter(lead => {
    if (lead.email) return false;
    const website = lead.website || lead.profileUrl;
    if (!website) return false;
    if (!CATEGORIES.includes(categoryOf(lead))) return false;
    const relevance = clinicRelevance({ name: lead.name, website, category: categoryOf(lead) });
    if (relevance.tier === 'exclude') return false;
    return TIER_ORDER[relevance.tier] <= TIER_ORDER[minTier];
  });

  console.log(`${leads.length} leads in store; ${targets.length} admitted with a site and no e-mail.`);
  if (!targets.length) {
    setOutput('enriched', '0');
    setOutput('attempted', '0');
    return;
  }

  const batch = targets.slice(0, limit);
  console.log(`Attempting ${batch.length} (limit ${limit}, minimum tier ${minTier}).${dryRun ? ' DRY RUN.' : ''}`);

  const byId = new Map(leads.map(lead => [lead.id, lead]));
  let enriched = 0;
  const unreachable = [];
  const nothingPublished = [];

  for (const lead of batch) {
    const website = lead.website || lead.profileUrl;
    let result;
    try {
      result = await enrichBusinessEmail({ website }, { maxPages: 5 });
    } catch (error) {
      // One dead site must never end the pass. Record and continue.
      unreachable.push(`${lead.name} (${error.message})`);
      continue;
    }

    if (result.status === 'blocked') {
      if (result.reason === 'OFFICIAL_WEBSITE_UNAVAILABLE') unreachable.push(lead.name);
      else nothingPublished.push(`${lead.name} — ${result.reason}`);
      continue;
    }

    const email = result.email || (result.candidates || [])[0]?.email;
    if (!email) {
      nothingPublished.push(`${lead.name} — no candidate cleared the confidence bar`);
      continue;
    }

    enriched += 1;
    console.log(`  found  ${lead.name}: ${email}`);
    if (dryRun) continue;

    const stored = byId.get(lead.id);
    stored.email = email;
    stored.contactChannel = 'email';
    // Provenance, so a bad enrichment is reversible and the origin is never
    // guessed later. `public_website` is the approved source type in
    // lib/contacts/sources.js — this pass introduces no new origin.
    stored.emailSource = {
      type: 'public_website',
      url: result.sourceUrl || website,
      confidence: result.confidence ?? (result.candidates || [])[0]?.confidence ?? null,
      enrichedAt: new Date().toISOString(),
      pass: 'enrich-missing-emails'
    };
  }

  console.log(`\nenriched: ${enriched} of ${batch.length} attempted`);
  console.log(`unreachable sites: ${unreachable.length}`);
  console.log(`reachable but publishing no usable address: ${nothingPublished.length}`);

  // A run where EVERY site was unreachable is an environment failure, not a
  // finding about the businesses. Saying so is the difference between "these
  // clinics publish no e-mail" and "this machine has no network".
  const allUnreachable = batch.length > 0 && unreachable.length === batch.length;
  if (allUnreachable) {
    console.error('\nEvery site was unreachable. That is a network result, not a data result.');
    console.error('This pass needs real outbound access — run it on the GitHub runner.');
  }
  setOutput('all_unreachable', String(allUnreachable));

  if (!dryRun && enriched > 0) {
    fs.writeFileSync(STORE, leads.map(lead => JSON.stringify(lead)).join('\n') + '\n');
    console.log(`\nWrote ${STORE}.`);
  }

  setOutput('enriched', String(enriched));
  setOutput('attempted', String(batch.length));

  if (unreachable.length) console.log(`\nUnreachable: ${unreachable.slice(0, 10).join(', ')}`);
  if (nothingPublished.length) console.log(`No address: ${nothingPublished.slice(0, 10).join('; ')}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

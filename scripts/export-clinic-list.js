#!/usr/bin/env node
'use strict';

// Build an outreach-ready clinic list from the harvested lead store.
//
//   npm run leads:clinics                       # med spas + clinics, contactable only
//   npm run leads:clinics -- --categories=med-spa,clinic,physiotherapy
//   npm run leads:clinics -- --channel=email    # only rows with an e-mail
//   npm run leads:clinics -- --csv=out.csv
//
// This is the authorized med-spa research-supply campaign's target list (owner
// amendment 2026-07-25): introduce Lion Elite Wellness as a Research-Use-Only
// peptide SUPPLIER to med spas, aesthetics and wellness clinics.
//
// Every row is passed through lib/contacts/acquisition.js acquire() rather than
// read straight out of the store, for two reasons. The store predates the gate,
// so it already holds at least one personal Gmail that a B2B campaign must not
// send to. And a list assembled by a different path than the pipeline's would
// be a fifth door — the exact thing the single-door design exists to prevent.
//
// Gyms are excluded by default. They are in the store because the discovery
// categories include them, but a gym is not a research-peptide buyer, and
// padding a target list with rows nobody will convert makes every downstream
// rate look worse than it is.

const fs = require('fs');
const path = require('path');
const { acquire } = require('../lib/contacts/acquisition');
const { clinicRelevance, TIER_ORDER } = require('../lib/contacts/clinic-targeting');

const DEFAULT_CATEGORIES = Object.freeze(['med-spa', 'clinic']);
const STORE = path.join(__dirname, '..', 'leads', 'harvested', 'leads.jsonl');

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function categoryOf(lead) {
  const subjects = (lead.matchedTerms || {}).subject || [];
  return subjects[0] || String(lead.matchedQuery || '').split('/')[1] || '';
}

function cityStateOf(lead) {
  // The address is one OSM-composed string: "1234 Alton Road Miami Beach FL 33139".
  // A lazy capture before the state swallowed the street too, producing a city
  // of "Alton Road Mia". Anchor on the state abbreviation and take only the
  // words immediately before it, stopping at a street-type word.
  const address = String(lead.address || '');
  const match = address.match(/\s([A-Z]{2})\s+\d{5}/);
  if (!match) return { city: '', state: '' };

  const state = match[1];
  const before = address.slice(0, match.index).trim().split(/\s+/);
  const streetTypes = new Set([
    'street', 'st', 'avenue', 'ave', 'road', 'rd', 'boulevard', 'blvd', 'drive',
    'dr', 'lane', 'ln', 'way', 'court', 'ct', 'place', 'pl', 'terrace', 'ter',
    'circle', 'cir', 'highway', 'hwy', 'parkway', 'pkwy', 'suite', 'ste', 'unit'
  ]);

  const words = [];
  for (let i = before.length - 1; i >= 0 && words.length < 3; i -= 1) {
    const word = before[i];
    if (streetTypes.has(word.toLowerCase().replace(/[.,]/g, ''))) break;
    if (/\d/.test(word)) break;
    words.unshift(word);
  }
  return { city: words.join(' ').replace(/[,]/g, '').trim(), state };
}

function main() {
  if (!fs.existsSync(STORE)) {
    console.error(`No lead store at ${STORE}.`);
    console.error('The store lives on the automation/leads branch:');
    console.error('  git show origin/automation/leads:leads/harvested/leads.jsonl > leads/harvested/leads.jsonl');
    process.exit(1);
  }

  const categories = String(arg('categories', DEFAULT_CATEGORIES.join(','))).split(',').map(s => s.trim()).filter(Boolean);
  const channel = arg('channel', 'any');
  const csvPath = arg('csv', null);

  const leads = fs.readFileSync(STORE, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

  const inScope = leads.filter(lead => categories.includes(categoryOf(lead)));

  // Straight through the pipeline's own door, so the list cannot contain
  // anything the pipeline would refuse to send to.
  const { accepted, refused } = acquire({
    sourceId: 'openstreetmap',
    records: inScope.map(lead => ({
      name: lead.name,
      website: lead.website || lead.profileUrl || '',
      email: lead.email,
      phone: lead.phone,
      address: lead.address
    })),
    env: process.env
  });

  // Re-attach the store fields acquire() does not carry, matched by name.
  const byName = new Map(inScope.map(lead => [lead.name, lead]));
  let rows = accepted.map(record => {
    const lead = byName.get(record.companyName) || {};
    const place = cityStateOf(lead);
    const category = categoryOf(lead);
    const relevance = clinicRelevance({
      name: record.companyName,
      website: lead.website || lead.profileUrl || '',
      category
    });
    return {
      tier: relevance.tier,
      company: record.companyName,
      category,
      city: place.city,
      state: place.state,
      phone: record.companyPhone || '',
      email: record.email || '',
      website: lead.website || lead.profileUrl || '',
      whyTargeted: relevance.reasons[0] || '',
      contactKind: record.contactKind || '',
      market: lead.region || '',
      sourceRef: lead.id || ''
    };
  });

  // Excluded rows never reach the file. A row this campaign must not contact is
  // not a low-priority row — leaving it in a CSV is how it gets sent to.
  const excluded = rows.filter(r => r.tier === 'exclude');
  rows = rows.filter(r => r.tier !== 'exclude');

  const minTier = arg('tier', null);
  if (minTier) rows = rows.filter(r => TIER_ORDER[r.tier] <= TIER_ORDER[minTier]);

  if (channel === 'email') rows = rows.filter(r => r.email);
  if (channel === 'phone') rows = rows.filter(r => r.phone);

  // Best rows first, and an e-mail outranks a phone within a tier, because the
  // e-mail rows are the ones that can actually be worked today.
  rows.sort((a, b) =>
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
    || Number(Boolean(b.email)) - Number(Boolean(a.email))
    || a.state.localeCompare(b.state)
    || a.city.localeCompare(b.city)
    || a.company.localeCompare(b.company));

  const header = ['tier', 'company', 'category', 'city', 'state', 'phone', 'email', 'website', 'whyTargeted', 'contactKind', 'market', 'sourceRef'];
  const csv = [header.join(','), ...rows.map(r => header.map(h => csvCell(r[h])).join(','))].join('\n');

  if (csvPath) {
    fs.writeFileSync(csvPath, csv + '\n');
    console.log(`Wrote ${rows.length} rows to ${csvPath}`);
  } else {
    console.log(csv);
  }

  const withEmail = rows.filter(r => r.email).length;
  const withPhone = rows.filter(r => r.phone).length;
  const byTier = rows.reduce((acc, r) => { acc[r.tier] = (acc[r.tier] || 0) + 1; return acc; }, {});

  console.error('');
  console.error(`Categories        : ${categories.join(', ')}`);
  console.error(`In store          : ${leads.length} leads, ${inScope.length} in these categories`);
  console.error(`Admitted by gate  : ${rows.length}`);
  console.error(`  high fit        : ${byTier.high || 0}  <- names aesthetic/hormone/longevity work`);
  console.error(`  medium fit      : ${byTier.medium || 0}  <- medical by tag, check the site`);
  console.error(`  low fit         : ${byTier.low || 0}`);
  if (excluded.length) {
    console.error(`Excluded from file: ${excluded.length}  (wrong trade, or must not be contacted)`);
    for (const entry of excluded.slice(0, 6)) {
      console.error(`  ${entry.company}: ${entry.whyTargeted}`);
    }
  }
  console.error(`  with e-mail     : ${withEmail}  <- the sendable list`);
  console.error(`  with phone only : ${withPhone - rows.filter(r => r.email && r.phone).length}  <- call or research the address`);
  if (refused.length) {
    console.error(`Refused by gate   : ${refused.length}`);
    for (const entry of refused.slice(0, 5)) {
      console.error(`  ${entry.companyName}: ${entry.blockers[0]}`);
    }
  }
  console.error('');
  console.error('E-mail only. These numbers carry no SMS consent, so texting them is');
  console.error('prohibited (TCPA). Content stays Research-Use-Only and is hard-gated by');
  console.error('lib/social/social-compliance.js. Sending stays a human action:');
  console.error('OUTREACH_SEND_ENABLED belongs to the owner. See docs/automated-outreach.md.');
}

if (require.main === module) main();
module.exports = { categoryOf, cityStateOf };

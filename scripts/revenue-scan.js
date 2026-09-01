#!/usr/bin/env node
'use strict';

/**
 * Daily revenue opportunity scan.
 *
 *   node scripts/revenue-scan.js                  # scan live sources
 *   node scripts/revenue-scan.js --sample         # worked example, no data needed
 *   node scripts/revenue-scan.js --json
 *   node scripts/revenue-scan.js --aov=12000 --welcome-rate=0.08
 *
 * Pulls every revenue signal Lion Elite already collects, ranks them against
 * each other by expected value per unit of effort, and names the single
 * highest-value action that can actually happen right now.
 *
 * Conversion rates are inputs, not defaults. Without them the scan still lists
 * and classifies every opportunity but reports value as unknown, because an
 * invented rate would reorder the queue and look authoritative doing it.
 */

const fs = require('fs');
const path = require('path');
const { scanOpportunities } = require('../lib/revenue/opportunity-scanner');
const { analyzeLeads } = require('../lib/leads/lead-analyzer');

const REPO_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { json: false, sample: false, limit: 15 };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
    else if (a === '--sample') args.sample = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--limit=')) args.limit = Math.max(1, Number(a.split('=')[1]) || 15);
    else if (a.startsWith('--aov=')) args.averageOrderValueCents = Math.round(Number(a.split('=')[1]) || 0);
    else if (a.startsWith('--welcome-rate=')) args.welcomeConversionRate = Number(a.split('=')[1]);
    else if (a.startsWith('--reorder-rate=')) args.reorderRate = Number(a.split('=')[1]);
    else if (a.startsWith('--inbound-rate=')) args.inboundConversionRate = Number(a.split('=')[1]);
  }
  return args;
}

const money = (cents) => (cents === null ? '     —' : `$${(cents / 100).toFixed(2)}`);

/** Inbound intent signals produced by the read-only Bluesky monitor. */
function loadInboundLeads() {
  const file = path.join(REPO_ROOT, 'claude-context', 'bluesky-leads.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).leads || [];
  } catch {
    return [];
  }
}

function loadGatedLeadAnalysis() {
  const { isConfigured, fetchMemberLeads } = require('../lib/leads/member-lead-source');
  if (!isConfigured()) return { configured: false, analysis: null };
  return { configured: true, fetch: fetchMemberLeads };
}

function sampleSources() {
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const gatedRows = [
    { name: 'Jordan Fields', email: 'jordan@example.com', phone: '+12165550142', email_marketing_consent: 1, sms_marketing_consent: 1, source: 'access_gate', created_at: daysAgo(38) },
    { name: 'Sam Ortiz', email: 'sam@example.com', phone: '2165550188', email_marketing_consent: 1, sms_marketing_consent: 0, source: 'access_gate', created_at: daysAgo(21) },
    { name: 'Drew Patel', email: 'drew@example.com', phone: '+12165550190', email_marketing_consent: 1, sms_marketing_consent: 1, source: 'checkout', created_at: daysAgo(1) },
    { name: 'Morgan Lee', email: 'morgan@example.com', phone: '', email_marketing_consent: 0, sms_marketing_consent: 0, source: 'access_gate', created_at: daysAgo(14) },
  ];
  return {
    gatedLeadAnalysis: analyzeLeads(gatedRows),
    reorderCustomers: [
      { email: 'repeat1@example.com', lastOrderAt: daysAgo(64), lastOrderValueCents: 14999, emailConsent: true },
      { email: 'repeat2@example.com', lastOrderAt: daysAgo(51), lastOrderValueCents: 8999, emailConsent: true },
      { email: 'optout@example.com', lastOrderAt: daysAgo(90), lastOrderValueCents: 22999, emailConsent: false },
    ],
    inboundLeads: loadInboundLeads(),
    funnelLeak: { from: 'lead_created', to: 'consent_captured', lost: 22, retainedPct: 51.1 },
  };
}

async function liveSources() {
  const sources = { inboundLeads: loadInboundLeads() };

  const gated = loadGatedLeadAnalysis();
  if (gated.configured) {
    sources.gatedLeadAnalysis = analyzeLeads(await gated.fetch());
  } else {
    sources.gatedLeadUnavailable =
      'member lead database not configured (set MEMBER_LEADS_DATABASE_URL / TURSO_DATABASE_URL)';
  }

  // Reorder customers and funnel leaks come from Postgres, which is not
  // reachable from every environment. Absent is reported as absent, never as
  // zero opportunities.
  return sources;
}

function render(scan, sources, args) {
  const lines = [];
  lines.push('LION ELITE — REVENUE OPPORTUNITY SCAN');
  lines.push('='.repeat(76));
  lines.push('');

  lines.push(`Opportunities found   ${scan.total}`);
  lines.push(`Actionable now        ${scan.actionableNow}`);
  lines.push(`Blocked               ${scan.blocked}`);
  lines.push(`Human-only            ${scan.humanOnly}`);
  if (scan.unestimated) {
    lines.push(`Value unknown         ${scan.unestimated}   (pass --aov and the rate flags to estimate)`);
  }
  if (scan.totalExpectedValueCents) {
    lines.push(`Expected value        ${money(scan.totalExpectedValueCents)}   (estimated items only)`);
  }

  if (sources.gatedLeadUnavailable) {
    lines.push('');
    lines.push(`!! Gated leads not scanned: ${sources.gatedLeadUnavailable}`);
    lines.push('   Those are consented signups. Until this is configured they are invisible here,');
    lines.push('   which is not the same as there being none.');
  }

  lines.push('');
  if (scan.topAction) {
    lines.push('DO THIS FIRST');
    lines.push(`  ${scan.topAction.recommendedAction}`);
    lines.push(`  ${scan.topAction.subject}   (${scan.topAction.type}, EV ${money(scan.topAction.expectedValueCents)})`);
  } else {
    lines.push('DO THIS FIRST');
    lines.push('  Nothing is actionable right now. Everything found is blocked or human-only —');
    lines.push('  see the queue below for what each one is waiting on.');
  }

  if (scan.topOverall && scan.topAction && scan.topOverall.id !== scan.topAction.id) {
    lines.push('');
    lines.push(`Highest value overall is blocked: ${scan.topOverall.subject}`);
    lines.push(`  ${scan.topOverall.recommendedAction}  [${scan.topOverall.blockers.join(', ') || 'human-only'}]`);
  }

  lines.push('');
  lines.push('BY TYPE');
  for (const [type, t] of Object.entries(scan.byType)) {
    const ev = t.estimable ? money(t.expectedValueCents) : '     —';
    lines.push(`  ${type.padEnd(26)} ${String(t.count).padStart(4)} found  ${ev} EV  ${t.blocked} blocked`);
  }

  lines.push('');
  lines.push(`RANKED QUEUE (top ${Math.min(args.limit, scan.ranked.length)})`);
  for (const o of scan.ranked.slice(0, args.limit)) {
    const flag = o.blocked ? 'BLOCKED ' : o.automatable ? 'ready   ' : 'human   ';
    const age = o.ageDays === null ? '   ' : `${String(o.ageDays).padStart(3)}d`;
    lines.push(`  ${flag} ${money(o.expectedValueCents).padStart(9)}  ${age}  ${String(o.subject).slice(0, 44).padEnd(44)} ${o.type}`);
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('usage: node scripts/revenue-scan.js [--sample] [--json] [--limit=N] [--aov=cents] [--welcome-rate=R] [--reorder-rate=R] [--inbound-rate=R]');
    return;
  }

  const sources = args.sample ? sampleSources() : await liveSources();
  const scan = scanOpportunities(sources, {
    averageOrderValueCents: args.averageOrderValueCents ?? null,
    welcomeConversionRate: args.welcomeConversionRate ?? null,
    reorderRate: args.reorderRate ?? null,
    inboundConversionRate: args.inboundConversionRate ?? null,
    stageToPurchaseRate: args.welcomeConversionRate ?? null,
  });

  if (args.json) {
    console.log(JSON.stringify(scan, null, 2));
    return;
  }

  if (args.sample) console.log('*** SAMPLE DATA — not from live sources ***\n');
  console.log(render(scan, sources, args));
  console.log('');
  console.log(`Sending remains OFF: OUTREACH_SEND_ENABLED=${process.env.OUTREACH_SEND_ENABLED || 'unset'}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[revenue-scan] ${error.message}`);
    process.exit(1);
  });

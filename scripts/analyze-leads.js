#!/usr/bin/env node
'use strict';

/**
 * Gated-lead activation report.
 *
 *   node scripts/analyze-leads.js                 # analyse live member_leads
 *   node scripts/analyze-leads.js --drafts        # also print ready-to-send drafts
 *   node scripts/analyze-leads.js --json
 *   node scripts/analyze-leads.js --sample        # worked example, no database
 *   node scripts/analyze-leads.js --limit=20
 *
 * Reads the storefront's gated-access leads, classifies who may be contacted on
 * which channel and why, and builds the compliance-validated welcome email for
 * everyone eligible.
 *
 * It never sends. Sending stays behind OUTREACH_SEND_ENABLED plus the Resend
 * vars, and remains an owner action.
 */

const { analyzeLeads, estimateValueAtRisk } = require('../lib/leads/lead-analyzer');
const { buildWelcomeEmail } = require('../lib/outreach/campaign-emails');

const UNSUBSCRIBE = process.env.OUTREACH_UNSUBSCRIBE_URL || process.env.OUTREACH_UNSUBSCRIBE_EMAIL || '';
const POSTAL = process.env.OUTREACH_POSTAL_ADDRESS || '';

function parseArgs(argv) {
  const args = { drafts: false, json: false, sample: false, limit: 25 };
  for (const a of argv.slice(2)) {
    if (a === '--drafts') args.drafts = true;
    else if (a === '--json') args.json = true;
    else if (a === '--sample') args.sample = true;
    else if (a.startsWith('--limit=')) args.limit = Math.max(1, Number(a.split('=')[1]) || 25);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/** Mirrors the real member_leads row shape, including the messy cases. */
function sampleRows() {
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
  return [
    { id: 1, name: 'Jordan Fields', email: 'jordan@example.com', phone: '(216) 555-0142', email_marketing_consent: 1, sms_marketing_consent: 1, source: 'access_gate', status: 'new', created_at: daysAgo(38) },
    { id: 2, name: 'Sam Ortiz', email: 'sam@example.com', phone: '2165550188', email_marketing_consent: 1, sms_marketing_consent: 0, source: 'access_gate', status: 'new', created_at: daysAgo(21) },
    { id: 3, name: 'Riley Chen', email: 'riley@example.com', phone: '', email_marketing_consent: 1, sms_marketing_consent: 0, source: 'access_gate', status: 'new', created_at: daysAgo(9) },
    { id: 4, name: 'Casey Brooks', email: 'casey@example.com', phone: '+12165550175', email_marketing_consent: 0, sms_marketing_consent: 1, source: 'access_gate', status: 'new', created_at: daysAgo(6) },
    { id: 5, name: 'Avery Nash', email: 'not-an-email', phone: '216555', email_marketing_consent: 1, sms_marketing_consent: 1, source: 'access_gate', status: 'new', created_at: daysAgo(3) },
    { id: 6, name: 'Drew Patel', email: 'drew@example.com', phone: '+12165550190', email_marketing_consent: 1, sms_marketing_consent: 1, source: 'checkout', status: 'new', created_at: daysAgo(1) },
    { id: 7, name: 'Morgan Lee', email: 'morgan@example.com', phone: '+12165550111', email_marketing_consent: 0, sms_marketing_consent: 0, source: 'access_gate', status: 'new', created_at: daysAgo(14) },
  ];
}

async function loadRows(args) {
  if (args.sample) return sampleRows();
  // Required lazily so --sample needs no database driver or credentials.
  const { fetchMemberLeads } = require('../lib/leads/member-lead-source');
  return fetchMemberLeads();
}

const pad = (s, n) => String(s).padEnd(n);

function render(analysis, args) {
  const lines = [];
  lines.push('LION ELITE — GATED LEAD ACTIVATION');
  lines.push('='.repeat(70));
  lines.push('');

  if (analysis.total === 0) {
    lines.push('No leads found.');
    lines.push('');
    lines.push('If the gate is live, this means the lead database is empty or not');
    lines.push('reachable from here — not that nobody signed up. Check');
    lines.push('TURSO_DATABASE_URL before concluding there is no demand.');
    return lines.join('\n');
  }

  lines.push(`Leads captured        ${analysis.total}`);
  lines.push(`Contactable now       ${analysis.actionable}   <-- opted in, never contacted`);
  lines.push(`  by email            ${analysis.emailReachable}`);
  lines.push(`  by SMS              ${analysis.smsReachable}   (${analysis.bothChannels} on both)`);
  lines.push(`Already contacted     ${analysis.alreadyContacted}`);
  lines.push(`Cannot contact        ${analysis.blocked}`);
  if (analysis.oldestLeadDays !== null) {
    lines.push(`Oldest lead           ${analysis.oldestLeadDays} days without contact`);
  }

  lines.push('');
  lines.push('WHY LEADS ARE BLOCKED');
  const blockers = Object.entries(analysis.byBlocker).sort((a, b) => b[1] - a[1]);
  if (!blockers.length) lines.push('  (none)');
  for (const [code, n] of blockers) lines.push(`  ${pad(code, 22)} ${n}`);

  lines.push('');
  lines.push('AGE OF LEADS');
  for (const [bucket, n] of Object.entries(analysis.byAge)) {
    if (n) lines.push(`  ${pad(bucket, 22)} ${n}`);
  }

  lines.push('');
  lines.push('BY SOURCE');
  for (const [source, s] of Object.entries(analysis.bySource)) {
    lines.push(`  ${pad(source, 22)} ${s.total} captured, ${s.actionable} contactable`);
  }

  lines.push('');
  lines.push(`PRIORITISED WORKLIST (top ${Math.min(args.limit, analysis.actionableLeads.length)})`);
  if (!analysis.actionableLeads.length) {
    lines.push('  Nobody is contactable. See the blocker breakdown above.');
  }
  for (const lead of analysis.actionableLeads.slice(0, args.limit)) {
    const channels = [lead.emailReachable ? 'email' : null, lead.smsReachable ? 'sms' : null].filter(Boolean).join('+');
    lines.push(`  ${pad(lead.name || '(no name)', 20)} ${pad(lead.email, 28)} ${pad(channels, 10)} ${lead.ageDays}d  ${lead.recommendedAction}`);
  }

  return lines.join('\n');
}

function renderDrafts(analysis, args) {
  const lines = ['', 'WELCOME DRAFTS', '='.repeat(70)];

  if (!UNSUBSCRIBE || !POSTAL) {
    lines.push('');
    lines.push('Cannot build consumer drafts: OUTREACH_UNSUBSCRIBE_URL (or _EMAIL) and');
    lines.push('OUTREACH_POSTAL_ADDRESS must be set. CAN-SPAM requires a working');
    lines.push('unsubscribe and a physical address on every consumer send, so the');
    lines.push('builder refuses rather than producing a non-compliant email.');
    return lines.join('\n');
  }

  let built = 0;
  let blocked = 0;
  for (const lead of analysis.actionableLeads.filter((l) => l.emailReachable).slice(0, args.limit)) {
    const draft = buildWelcomeEmail({
      firstName: lead.firstName,
      unsubscribeUrl: UNSUBSCRIBE,
      postalAddress: POSTAL,
    });
    if (!draft.approved) {
      blocked += 1;
      lines.push('', `-- ${lead.email}: BLOCKED by compliance: ${JSON.stringify(draft.compliance.blockers)}`);
      continue;
    }
    built += 1;
    lines.push('', `-- to: ${lead.email}`, `   subject: ${draft.subject}`);
    if (built === 1) lines.push('', draft.body.split('\n').map((l) => `   ${l}`).join('\n'));
  }
  lines.push('', `${built} draft(s) built, ${blocked} blocked by compliance.`);
  lines.push('(First body shown in full; the rest differ only by first name.)');
  lines.push('');
  lines.push(`Sending is OFF: OUTREACH_SEND_ENABLED=${process.env.OUTREACH_SEND_ENABLED || 'unset'}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('usage: node scripts/analyze-leads.js [--drafts] [--json] [--sample] [--limit=N]');
    return;
  }

  const rows = await loadRows(args);
  const analysis = analyzeLeads(rows);

  if (args.json) {
    console.log(JSON.stringify({ analysis, valueAtRisk: estimateValueAtRisk(analysis, {}) }, null, 2));
    return;
  }

  if (args.sample) console.log('*** SAMPLE DATA — not from the database ***\n');
  console.log(render(analysis, args));
  if (args.drafts) console.log(renderDrafts(analysis, args));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[analyze-leads] ${error.message}`);
    process.exit(1);
  });

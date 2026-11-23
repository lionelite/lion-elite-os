#!/usr/bin/env node
'use strict';

/**
 * Daily executive revenue report (Issue #89, P1).
 *
 *   node scripts/revenue-report.js                 # yesterday -> now, from Postgres
 *   node scripts/revenue-report.js --days=7        # 7-day window
 *   node scripts/revenue-report.js --json          # machine-readable
 *   node scripts/revenue-report.js --sample        # worked example, no database
 *
 * --sample exists so the report can be seen working before any emitter is wired
 * or any database is reachable. It is clearly labelled and never touches Postgres.
 */

const { buildReport, renderReport } = require('../lib/revenue/executive-report');

function parseArgs(argv) {
  const args = { days: 1, json: false, sample: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (arg === '--sample') args.sample = true;
    else if (arg.startsWith('--days=')) args.days = Math.max(1, Number(arg.split('=')[1]) || 1);
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

/**
 * A small but realistic day: organic and affiliate carrying Wellness, a paid
 * test that produced leads and no orders, and one coaching close on Beauty.
 */
function sampleEvents() {
  const at = (h) => new Date(Date.UTC(2026, 7, 4, h, 0, 0));
  const ev = (type, brand, source, subjectId, amountCents, hour) => ({
    type, brand, source, subjectId, amountCents: amountCents ?? null, occurredAt: at(hour), metadata: {},
  });

  const events = [];
  for (let i = 0; i < 24; i += 1) events.push(ev('lead_created', 'wellness', i < 14 ? 'organic' : 'affiliate', `w${i}`, null, 8));
  for (let i = 0; i < 19; i += 1) events.push(ev('consent_captured', 'wellness', i < 12 ? 'organic' : 'affiliate', `w${i}`, null, 9));
  for (let i = 0; i < 19; i += 1) events.push(ev('welcome_email_sent', 'wellness', i < 12 ? 'organic' : 'affiliate', `w${i}`, null, 9));
  for (let i = 0; i < 6; i += 1) events.push(ev('reply_received', 'wellness', i < 4 ? 'organic' : 'affiliate', `w${i}`, null, 11));
  for (let i = 0; i < 5; i += 1) events.push(ev('qualified', 'wellness', i < 3 ? 'organic' : 'affiliate', `w${i}`, null, 12));
  for (let i = 0; i < 5; i += 1) events.push(ev('offer_sent', 'wellness', i < 3 ? 'organic' : 'affiliate', `w${i}`, null, 13));
  events.push(ev('purchase_completed', 'wellness', 'organic', 'w0', 14999, 15));
  events.push(ev('purchase_completed', 'wellness', 'affiliate', 'w4', 8999, 16));
  events.push(ev('repeat_purchase', 'wellness', 'organic', 'w7', 10999, 17));

  for (let i = 0; i < 9; i += 1) events.push(ev('lead_created', 'wellness', 'paid_meta', `p${i}`, null, 10));
  for (let i = 0; i < 4; i += 1) events.push(ev('consent_captured', 'wellness', 'paid_meta', `p${i}`, null, 10));

  for (let i = 0; i < 7; i += 1) events.push(ev('lead_created', 'beauty', 'social_organic', `b${i}`, null, 9));
  for (let i = 0; i < 3; i += 1) events.push(ev('coaching_application', 'beauty', 'social_organic', `b${i}`, null, 14));
  events.push(ev('coaching_close', 'beauty', 'social_organic', 'b0', 240000, 18));

  for (let i = 0; i < 5; i += 1) events.push(ev('lead_created', 'alexthelionlifts', 'social_organic', `a${i}`, null, 9));

  return events;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log('usage: node scripts/revenue-report.js [--days=N] [--json] [--sample]');
    return;
  }

  let events;
  if (args.sample) {
    events = sampleEvents();
  } else {
    // Required lazily so --sample works with no DATABASE_URL configured.
    const { eventsInWindow } = require('../lib/revenue/funnel-store');
    events = await eventsInWindow({ windowDays: args.days });
  }

  const report = buildReport({ events, windowDays: args.days });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (args.sample) console.log('*** SAMPLE DATA — not from the database ***\n');
    console.log(renderReport(report));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[revenue-report] ${error.message}`);
    process.exit(1);
  });

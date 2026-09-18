#!/usr/bin/env node
'use strict';

// CLI for the agency delivery engine.
//
//   node agency/cli.js --client agency/examples/cedar-roofing.json
//   node agency/cli.js --client <file> --proposal      # client-facing proposal
//   node agency/cli.js --client <file> --internal      # internal delivery plan
//   node agency/cli.js --client <file> --tickets       # every ticket body
//   node agency/cli.js --client <file> --json          # the raw engagement
//   node agency/cli.js --scope "they also want a mobile app"
//
// Read-only: it prints. It does not send, publish, invoice, or open issues.

const fs = require('node:fs');
const path = require('node:path');

const { planEngagement } = require('./src/engagement');
const { buildProposal, buildInternalPlan, buildTicketIssue } = require('./src/proposal');
const { scopeGuard, OFFER_STATEMENT, TARGET_VERTICALS } = require('./src/offer');

function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--client' || arg === '-c') { args.client = argv[++i]; continue; }
    if (arg === '--scope') { args.scope = argv[++i]; continue; }
    if (arg.startsWith('--')) args.flags.add(arg.slice(2));
  }
  return args;
}

function money(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

function summary(e) {
  const out = [];
  out.push(`Offer: ${OFFER_STATEMENT}`);
  out.push('');
  out.push(`${e.clientName} (${e.clientRef}) — stage: ${e.stage}`);
  out.push('');
  if (e.qualification) {
    const o = e.qualification.opportunity;
    out.push(`Value found:      ${money(o.annualRecoverableValue)}/yr  (${money(o.revenueGainedMonthly)}/mo revenue + ${money(o.costReducedMonthly)}/mo time)`);
    out.push(`Missed leads:     ${o.missedLeadsMonthly}/mo, of which we model recovering ${o.recoveredLeadsMonthly}`);
  }
  if (e.economics) {
    const ec = e.economics;
    out.push('');
    out.push(`Quote:            ${money(ec.projectPrice)}  (deposit ${money(ec.depositAmount)}, balance ${money(ec.balanceAmount)})`);
    out.push(`Our costs:        delivery ${money(ec.developerCost)} + operating ${money(ec.opsCost)}`);
    out.push(`Gross profit:     ${money(ec.grossProfit)}  (${ec.grossMarginPct}%)`);
    if (ec.monthlyRetainer > 0) out.push(`Retainer:         ${money(ec.monthlyRetainer)}/mo → ${money(ec.yearOneRevenue)} year-one revenue`);
    else if (e.retainer && e.retainer.quarterlyOptimization) out.push(`Support:          ${money(e.retainer.quarterlyOptimization)}/quarter optimization (monthly retainer not viable at this value)`);
    if (ec.roi) out.push(`Client return:    ${ec.roi.roiMultiple}x year one, ${ec.roi.paybackMonths}-month build payback`);
    out.push(`Cash flow:        ${e.cashFlow.solvent ? 'solvent' : 'NEGATIVE'} (lowest ${money(e.cashFlow.lowestBalance)})`);
    out.push(`Delivery:         ${e.deliveryPlan.milestones.length} milestones, ${e.deliveryPlan.ticketCount} tickets, ${e.deliveryPlan.acceptanceTestCount} acceptance tests`);
  }
  if (e.blockers && e.blockers.length) {
    out.push('');
    out.push('BLOCKERS:');
    for (const b of e.blockers) out.push(`  ✗ ${b}`);
  }
  if (e.gaps && e.gaps.length) {
    out.push('');
    out.push('MISSING DISCOVERY FACTS:');
    for (const g of e.gaps) out.push(`  ? ${g}`);
  }
  if (e.escalations && e.escalations.length) {
    out.push('');
    out.push('OWNER DECISION REQUIRED:');
    for (const x of e.escalations) out.push(`  ! ${x}`);
  }
  if (e.notes && e.notes.length) {
    out.push('');
    for (const n of e.notes) out.push(`  · ${n}`);
  }
  out.push('');
  out.push(e.recommendation);
  return out.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.scope) {
    const result = scopeGuard(args.scope);
    console.log(`In scope: ${result.inScope ? 'yes' : 'NO'}`);
    for (const d of result.declines) console.log(`  ✗ Decline: ${d.reason}`);
    for (const a of result.addOns) console.log(`  + Priced add-on: ${a.name} — ${a.note}`);
    return;
  }

  if (!args.client) {
    console.log('Usage: node agency/cli.js --client <file.json> [--proposal|--internal|--tickets|--json]');
    console.log('       node agency/cli.js --scope "<what the prospect asked for>"');
    console.log('');
    console.log('Target verticals:');
    for (const v of TARGET_VERTICALS) console.log(`  ${v.id.padEnd(24)} ${v.name}`);
    process.exitCode = 1;
    return;
  }

  const file = path.resolve(args.client);
  if (!fs.existsSync(file)) {
    console.error(`No such client file: ${file}`);
    process.exitCode = 1;
    return;
  }
  const client = JSON.parse(fs.readFileSync(file, 'utf8'));
  const engagement = planEngagement(client);

  if (args.flags.has('json')) {
    console.log(JSON.stringify(engagement, null, 2));
    return;
  }
  if (args.flags.has('proposal')) {
    if (!engagement.proceed) {
      console.error(`Cannot build a proposal — stage is "${engagement.stage}".`);
      console.error(summary(engagement));
      process.exitCode = 1;
      return;
    }
    console.log(buildProposal(engagement));
    return;
  }
  if (args.flags.has('internal')) {
    console.log(buildInternalPlan(engagement));
    return;
  }
  if (args.flags.has('tickets')) {
    for (const ticket of engagement.deliveryPlan.tickets) {
      console.log(buildTicketIssue(ticket, engagement));
      console.log('\n---\n');
    }
    return;
  }
  console.log(summary(engagement));
}

if (require.main === module) main();

module.exports = { summary };

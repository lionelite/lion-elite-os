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
// Ledger (state that survives the process exiting):
//   node agency/cli.js --client <file> --open          # open an engagement ledger
//   node agency/cli.js --ledger <ref>                  # show one engagement
//   node agency/cli.js --ledger <ref> --sent           # record the proposal going out
//   node agency/cli.js --ledger <ref> --receipt 12600 --kind deposit
//   node agency/cli.js --ledger <ref> --state in_delivery
//   node agency/cli.js --portfolio                     # roll-up across all ledgers
//
// Bench:
//   node agency/cli.js --bench                         # roster, capacity, track record
//   node agency/cli.js --ledger <ref> --suggest <ticketId>
//   node agency/cli.js --ledger <ref> --assign <ticketId> --to <contractorId>
//
// It prints and it writes local ledger files. It does not send, publish,
// invoice, or open issues.

const fs = require('node:fs');
const path = require('node:path');

const { planEngagement } = require('./src/engagement');
const { buildProposal, buildInternalPlan, buildTicketIssue } = require('./src/proposal');
const { scopeGuard, OFFER_STATEMENT, TARGET_VERTICALS } = require('./src/offer');
const ledgerOps = require('./src/ledger');
const store = require('./src/ledger-store');
const portfolio = require('./src/portfolio');
const bench = require('./src/bench');
const { assignTicket } = require('./src/contractor');

function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--client' || arg === '-c') { args.client = argv[++i]; continue; }
    if (arg === '--scope') { args.scope = argv[++i]; continue; }
    if (arg === '--ledger') { args.ledger = argv[++i]; continue; }
    if (arg === '--receipt') { args.receipt = argv[++i]; continue; }
    if (arg === '--kind') { args.kind = argv[++i]; continue; }
    if (arg === '--state') { args.state = argv[++i]; continue; }
    if (arg === '--note') { args.note = argv[++i]; continue; }
    if (arg === '--assign') { args.assign = argv[++i]; continue; }
    if (arg === '--suggest') { args.suggest = argv[++i]; continue; }
    if (arg === '--to') { args.to = argv[++i]; continue; }
    if (arg.startsWith('--')) args.flags.add(arg.slice(2));
  }
  return args;
}

function money(n) {
  const v = Math.round(Number(n) || 0);
  // Sign outside the symbol: "-$7,700", not "$-7,700".
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US')}`;
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

function renderLedger(ledger) {
  const e = ledgerOps.economics(ledger);
  const out = [];
  out.push(`${ledger.clientName} (${ledger.clientRef}) — ${ledger.state}`);
  out.push('');
  if (ledger.planned) {
    out.push(`Contract:         ${money(ledger.planned.projectPrice)}  (deposit ${money(ledger.planned.depositAmount)}, balance ${money(ledger.planned.balanceAmount)})`);
  }
  out.push(`Collected:        ${money(e.received)}   Paid out: ${money(e.developerPaid)}   Operating: ${money(e.opsSpent)}`);
  out.push(`Cash position:    ${money(e.cashPosition)}`);
  if (e.outstandingFromClient > 0) out.push(`Outstanding:      ${money(e.outstandingFromClient)} still owed by the client`);
  out.push(`Milestones:       ${e.milestonesAccepted}/${e.milestonesTotal} accepted`);
  if (e.unpaidAcceptedMilestones.length) out.push(`Unpaid (accepted): ${e.unpaidAcceptedMilestones.join(', ')}`);
  const disputed = ledgerOps.disputedTickets(ledger);
  if (disputed.length) out.push(`DISPUTED:         ${disputed.join(', ')} — payment held until decided`);
  // Only call it profit when it is profit. Before the build is collected and
  // paid out, the honest line is the cash position above.
  if (e.profitIsFinal) {
    out.push(`Gross profit:     ${money(e.grossProfit)}  (${e.grossMarginPct}% of build revenue)`);
  } else if (e.developerPaid > 0 || e.opsSpent > 0) {
    out.push(`Spent to date:    ${money(e.developerPaid + e.opsSpent)} of a planned ${money(ledger.planned.developerCost + ledger.planned.opsCost)}`);
  }
  // Variance is only meaningful once money has actually moved. Printing
  // "delivery -$7,700" on a ledger where nothing has been spent reads as a
  // problem rather than as "we have not started".
  if (e.variance && (e.developerPaid > 0 || e.variance.final)) {
    out.push(`Variance vs plan: delivery ${e.variance.developerCost >= 0 ? '+' : ''}${money(e.variance.developerCost)}, profit ${e.variance.grossProfit >= 0 ? '+' : ''}${money(e.variance.grossProfit)}${e.variance.final ? '' : ' (in progress)'}`);
  }
  out.push('');
  out.push(`NEXT: ${ledgerOps.nextAction(ledger)}`);
  return out.join('\n');
}

function requireLedger(ref) {
  const ledger = store.loadLedger(ref);
  if (!ledger) throw new Error(`No ledger for "${ref}". Open one with: --client <file> --open`);
  return ledger;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has('portfolio')) {
    console.log(portfolio.renderReport(store.listLedgers()));
    return;
  }

  if (args.flags.has('bench')) {
    console.log(bench.renderBench(store.loadBench(), store.listLedgers()));
    return;
  }

  if (args.ledger) {
    let ledger = requireLedger(args.ledger);
    let mutated = false;

    // Both of these need the ticket object, which carries the access plan — so
    // they replan the engagement rather than trusting a ticket id alone.
    if (args.suggest || args.assign) {
      const ticketId = args.suggest || args.assign;
      const engagement = planEngagement(store.loadClient(ledger.clientRef));
      const ticket = engagement.deliveryPlan.tickets.find((t) => t.id === ticketId);
      if (!ticket) {
        throw new Error(`No ticket "${ticketId}" on ${ledger.clientRef}. Run --tickets to list them.`);
      }
      const roster = store.loadBench();
      const ledgers = store.listLedgers();

      if (args.suggest) {
        const result = bench.recommendAssignee(roster, ticket, ledgers);
        console.log(`Ticket ${ticket.id} (${ticket.milestoneId}) — $${ticket.fixedPrice.toLocaleString('en-US')}, ${ticket.accessPlan.effectiveTier} tier`);
        console.log('');
        console.log(result.reason);
        if (result.ranked.length) {
          console.log('');
          console.log('Ranked:');
          for (const c of result.ranked) {
            const perf = c.performance.firstPassRate === null ? 'no record' : `${Math.round(c.performance.firstPassRate * 100)}% first-pass`;
            console.log(`  ${c.name.padEnd(20)} ${perf}, ${c.headroom} free`);
          }
        }
        if (result.excluded.length) {
          console.log('');
          console.log('Not available:');
          for (const c of result.excluded) console.log(`  ${(c.name || c.contractorId).padEnd(20)} ${c.blockers.join(' ')}`);
        }
        return;
      }

      // Assignment goes through contractor.assignTicket(), which throws on
      // unpapered contractors — the bench check is additional, never a substitute.
      const contractor = bench.getContractor(roster, args.to);
      if (!contractor) throw new Error(`${args.to || 'No contractor'} is not on the bench. Add them first.`);
      const check = bench.eligibilityFor(roster, contractor.id, ticket, ledgers);
      if (!check.assignable) {
        throw new Error(`Cannot assign ${ticket.id} to ${contractor.name}: ${check.blockers.join(' ')}`);
      }
      const assignment = assignTicket(ticket, contractor);
      assignment.milestoneId = ticket.milestoneId;
      ledgerOps.recordAssignment(ledger, assignment);
      store.saveLedger(ledger);
      console.log(`Assigned ${ticket.id} to ${contractor.name} at $${ticket.fixedPrice.toLocaleString('en-US')} (${assignment.accessTier} tier).`);
      console.log(`They now hold ${check.load + 1} of ${check.capacity} concurrent tickets.`);
      return;
    }

    if (args.flags.has('sent')) { ledgerOps.recordProposalSent(ledger, { note: args.note }); mutated = true; }
    if (args.receipt !== undefined) {
      ledgerOps.recordReceipt(ledger, { amount: Number(args.receipt), kind: args.kind || 'deposit' });
      mutated = true;
    }
    if (args.state) { ledgerOps.transition(ledger, args.state, { note: args.note }); mutated = true; }

    if (mutated) {
      store.saveLedger(ledger);
      ledger = requireLedger(args.ledger);
    }
    console.log(renderLedger(ledger));
    return;
  }

  if (args.scope) {
    const result = scopeGuard(args.scope);
    console.log(`In scope: ${result.inScope ? 'yes' : 'NO'}`);
    for (const d of result.declines) console.log(`  ✗ Decline: ${d.reason}`);
    for (const a of result.addOns) console.log(`  + Priced add-on: ${a.name} — ${a.note}`);
    return;
  }

  if (!args.client) {
    console.log('Usage: node agency/cli.js --client <file.json> [--proposal|--internal|--tickets|--json|--open]');
    console.log('       node agency/cli.js --scope "<what the prospect asked for>"');
    console.log('       node agency/cli.js --ledger <ref> [--sent|--receipt <n> --kind <k>|--state <s>]');
    console.log('       node agency/cli.js --portfolio');
    console.log('       node agency/cli.js --bench');
    console.log('       node agency/cli.js --ledger <ref> --suggest <ticketId>');
    console.log('       node agency/cli.js --ledger <ref> --assign <ticketId> --to <contractorId>');
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
  if (args.flags.has('open')) {
    const existing = store.loadLedger(engagement.clientRef);
    if (existing) {
      console.error(`A ledger already exists for ${engagement.clientRef} (state: ${existing.state}). Refusing to overwrite it.`);
      console.error('Inspect it with: --ledger ' + engagement.clientRef);
      process.exitCode = 1;
      return;
    }
    const ledger = ledgerOps.openLedger(engagement);
    const file = store.saveLedger(ledger);
    console.log(`Opened ledger at ${file}`);
    console.log('');
    console.log(renderLedger(ledger));
    return;
  }
  console.log(summary(engagement));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    // The engine refuses illegal moves by throwing. At the CLI boundary that
    // should read as a refusal with a reason, not as a crash.
    console.error(`Refused: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { summary };

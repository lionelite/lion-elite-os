'use strict';

// Document generation: the client-facing proposal, the internal delivery plan,
// and the per-ticket GitHub issue body.
//
// The proposal sells the OUTCOME, in the client's own numbers, and it never
// mentions how the work gets done. That is not secrecy for its own sake: the
// moment a client sees a delivery cost line they are negotiating our margin
// instead of evaluating their return, and the moment they learn which contractor
// wrote which module they have a route around us.
//
// assertNoInternalLeakage() enforces this mechanically. Every client-facing
// document is run through it before it is returned, so a future edit to the
// template cannot quietly start leaking cost figures.

const INTERNAL_TERMS = [
  /\bcontractors?\b/i,
  /\bsubcontract/i,
  /\bdeveloper\s+(cost|budget|payout|payment|rate)\b/i,
  /\bgross\s+(margin|profit)\b/i,
  /\bmargin\b/i,
  /\bpayout\b/i,
  /\bour\s+cost\b/i,
  /\bfixed[- ]price\s+ticket\b/i,
  /\bbench\s+rate/i,
];

function money(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

function pct(n) {
  return `${Math.round((Number(n) || 0) * 100)}%`;
}

/**
 * Throw if a client-facing document contains an internal term or one of the
 * engagement's internal dollar figures. `figures` are checked in both raw and
 * comma-formatted form, because "7700" and "7,700" are the same leak.
 */
function assertNoInternalLeakage(markdown, figures = []) {
  const found = [];
  for (const rule of INTERNAL_TERMS) {
    const m = markdown.match(rule);
    if (m) found.push(`internal term "${m[0]}"`);
  }
  for (const figure of figures) {
    const n = Math.round(Number(figure) || 0);
    if (n <= 0) continue;
    const raw = String(n);
    const formatted = n.toLocaleString('en-US');
    // Require a currency or word boundary so a coincidental digit run in a
    // date or a lead count is not a false positive.
    if (new RegExp(`\\$\\s?(${raw}|${formatted.replace(/,/g, ',')})\\b`).test(markdown)) {
      found.push(`internal figure ${money(n)}`);
    }
  }
  if (found.length) {
    throw new Error(`Client-facing document leaks internal detail: ${found.join(', ')}. Fix the template — do not ship this.`);
  }
  return true;
}

/**
 * The client-facing proposal. Structure follows the sales logic, not the build
 * order: their problem in their numbers, what they get, what it costs, what
 * happens next.
 */
function buildProposal(engagement) {
  if (!engagement || !engagement.proceed) {
    throw new Error('Refusing to build a proposal for an engagement that is not ready to propose. Resolve blockers or complete discovery first.');
  }
  const e = engagement;
  const o = e.qualification.opportunity;
  const roi = e.quote.roi;
  const a = o.assumptions;

  const lines = [];
  lines.push(`# Proposal — ${e.clientName}`);
  lines.push('');
  // The vertical's display name is deliberately omitted: the client knows their
  // own industry, and some of those labels ("Specialty contractors") collide with
  // the internal vocabulary this document must never use.
  lines.push(`**Prepared for:** ${e.clientName}  `);
  lines.push(`**Engagement:** Missed-Revenue Recovery System  `);
  lines.push(`**Reference:** ${e.clientRef}`);
  lines.push('');
  lines.push('## The problem, in your numbers');
  lines.push('');
  lines.push(`Roughly **${o.missedLeadsMonthly} inbound leads a month are never properly worked** — never contacted at all, or contacted too late to matter. That is the leak this system closes.`);
  lines.push('');
  lines.push('| | Monthly | Annual |');
  lines.push('|---|---|---|');
  lines.push(`| Leads currently going unworked | ${o.missedLeadsMonthly} | ${Math.round(o.missedLeadsMonthly * 12)} |`);
  lines.push(`| Leads we expect to recover | ${o.recoveredLeadsMonthly} | ${Math.round(o.recoveredLeadsMonthly * 12)} |`);
  lines.push(`| Additional customers won | ${o.recoveredCustomersMonthly} | ${Math.round(o.recoveredCustomersMonthly * 12)} |`);
  lines.push(`| **Revenue recovered** | **${money(o.revenueGainedMonthly)}** | **${money(o.revenueGainedAnnual)}** |`);
  if (o.costReducedMonthly > 0) {
    lines.push(`| Staff time returned (${o.hoursSavedWeekly} hrs/week) | ${money(o.costReducedMonthly)} | ${money(o.costReducedAnnual)} |`);
  }
  lines.push(`| **Total value** | **${money(o.revenueGainedMonthly + o.costReducedMonthly)}** | **${money(o.annualRecoverableValue)}** |`);
  lines.push('');
  lines.push('### How these numbers were built');
  lines.push('');
  lines.push('Your figures — lead volume, the share going unworked, your close rate and your average customer value — are as you reported them. Ours are stated plainly so you can challenge them:');
  lines.push('');
  lines.push(`- We assume we recover **${pct(a.recoveryRate)}** of unworked leads. Not all of them: a lead that went cold weeks ago is often gone.`);
  lines.push(`- We assume a recovered lead closes at **${pct(a.recoveredCloseDiscount)} of your normal close rate**, because it is older and was already missed once.`);
  if (o.costReducedMonthly > 0) {
    lines.push(`- We assume **${pct(a.manualTimeReclaimed)}** of current manual chase time is returned, at ${money(a.loadedHourlyCost)}/hour loaded cost.`);
  }
  lines.push('');
  lines.push('If any of your inputs are wrong, tell us and we will rebuild the table. We would rather revise this now than defend a number we both stopped believing.');
  lines.push('');
  lines.push('## What we build');
  lines.push('');
  for (const cap of e.deliveryPlan.capabilities) {
    lines.push(`**${cap.name}** — ${cap.outcome}`);
    lines.push('');
  }
  lines.push('## Milestones and how you verify each one');
  lines.push('');
  lines.push('Every milestone has acceptance criteria agreed before work starts. You verify against those criteria, not against an opinion.');
  lines.push('');
  for (const [i, m] of e.deliveryPlan.milestones.entries()) {
    lines.push(`### ${i + 1}. ${m.name}`);
    lines.push('');
    for (const d of m.deliverables) lines.push(`- ${d}`);
    lines.push('');
    lines.push('*Accepted when:*');
    for (const t of m.acceptanceTests) lines.push(`- ${t.statement}`);
    lines.push('');
  }
  lines.push('## Investment');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| System build (fixed price) | **${money(e.quote.projectPrice)}** |`);
  lines.push(`| Due on signature (${pct(e.quote.depositRate)}) | ${money(e.quote.depositAmount)} |`);
  lines.push(`| Due on final acceptance | ${money(e.quote.balanceAmount)} |`);
  if (e.retainer.structure === 'monthly' && e.quote.monthlyRetainer > 0) {
    lines.push(`| Ongoing management & optimization | ${money(e.quote.monthlyRetainer)} / month |`);
  } else if (e.retainer.quarterlyOptimization) {
    lines.push(`| Quarterly optimization review | ${money(e.retainer.quarterlyOptimization)} / quarter |`);
  }
  lines.push('');
  lines.push(`At ${money(e.quote.projectPrice)} against ${money(o.annualRecoverableValue)} of year-one value, the build pays for itself in **${roi.paybackMonths} months**.`);
  lines.push('');
  lines.push('The price is fixed. It does not move with hours spent.');
  lines.push('');
  lines.push('## What is not included');
  lines.push('');
  lines.push('- Third-party software and messaging costs (your accounts, your rates)');
  lines.push('- Integrations beyond the list agreed in the scope document');
  lines.push('- Data migration from an existing CRM (quoted separately after a data audit)');
  lines.push('- Additional locations or business units beyond the first');
  lines.push('');
  lines.push('We do not guarantee a revenue figure. We guarantee the system, the acceptance criteria, and the reporting that shows you what it actually produced.');
  lines.push('');
  lines.push('## What we need from you');
  lines.push('');
  lines.push('- A named decision-maker who can approve scope and sign off milestones');
  lines.push('- Access to the systems listed in the scope document');
  lines.push('- Your approval on message templates before anything is sent to your leads');
  lines.push('- 90 minutes for discovery, then roughly an hour per milestone review');
  lines.push('');
  lines.push('## Next step');
  lines.push('');
  lines.push(`Countersign this proposal and settle the ${money(e.quote.depositAmount)} deposit. Discovery starts within five business days of both.`);
  lines.push('');

  const markdown = lines.join('\n');
  // Enforce the boundary before this can be sent anywhere.
  assertNoInternalLeakage(markdown, [
    e.economics.developerCost,
    e.economics.opsCost,
    e.economics.grossProfit,
    e.economics.yearOneGrossProfit,
    ...e.deliveryPlan.milestones.map((m) => m.developerPayout),
    ...e.deliveryPlan.tickets.map((t) => t.fixedPrice),
  ]);
  return markdown;
}

/**
 * The internal delivery plan — everything the proposal deliberately omits.
 * This document never goes to the client and never to a contractor.
 */
function buildInternalPlan(engagement) {
  const e = engagement;
  const lines = [];
  lines.push(`# INTERNAL — Delivery plan: ${e.clientName} (${e.clientRef})`);
  lines.push('');
  lines.push('> Internal only. Not for the client. Not for contractors.');
  lines.push('');
  lines.push(`**Stage:** ${e.stage}  |  **Proceed:** ${e.proceed ? 'yes' : 'no'}`);
  lines.push('');

  if (e.blockers && e.blockers.length) {
    lines.push('## Blockers');
    lines.push('');
    for (const b of e.blockers) lines.push(`- ${b}`);
    lines.push('');
  }
  if (e.escalations && e.escalations.length) {
    lines.push('## Owner decisions required');
    lines.push('');
    for (const x of e.escalations) lines.push(`- ${x}`);
    lines.push('');
  }
  if (e.gaps && e.gaps.length) {
    lines.push('## Missing discovery facts');
    lines.push('');
    for (const g of e.gaps) lines.push(`- ${g}`);
    lines.push('');
  }
  if (e.notes && e.notes.length) {
    lines.push('## Notes');
    lines.push('');
    for (const n of e.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  if (!e.economics) {
    lines.push('No pricing produced — prospect was disqualified at qualification.');
    lines.push('');
    return lines.join('\n');
  }

  const ec = e.economics;
  lines.push('## Economics');
  lines.push('');
  lines.push('| Line | Amount |');
  lines.push('|---|---|');
  lines.push(`| Client price (build) | ${money(ec.projectPrice)} |`);
  lines.push(`| Deposit collected upfront | ${money(ec.depositAmount)} |`);
  lines.push(`| Balance on acceptance | ${money(ec.balanceAmount)} |`);
  lines.push(`| Developer delivery cost | (${money(ec.developerCost)}) |`);
  lines.push(`| Software / operating cost | (${money(ec.opsCost)}) |`);
  lines.push(`| **Gross profit on build** | **${money(ec.grossProfit)}** |`);
  lines.push(`| Gross margin | ${ec.grossMarginPct}% |`);
  if (ec.monthlyRetainer > 0) lines.push(`| Monthly retainer | ${money(ec.monthlyRetainer)} |`);
  if (e.retainer && e.retainer.quarterlyOptimization) lines.push(`| Quarterly optimization | ${money(e.retainer.quarterlyOptimization)} |`);
  lines.push(`| Year-one revenue | ${money(ec.yearOneRevenue)} |`);
  lines.push(`| Year-one gross profit | ${money(ec.yearOneGrossProfit)} |`);
  lines.push('');
  if (ec.roi) {
    lines.push(`Client-side: ${money(ec.roi.yearOneValue)} year-one value, ${ec.roi.roiMultiple}x return, ${ec.roi.paybackMonths}-month build payback.`);
    lines.push('');
  }
  // quote.warnings already folds in the ROI warnings — print the set once.
  for (const w of e.quote.warnings || []) lines.push(`- ⚠ ${w}`);
  if ((e.quote.warnings || []).length) lines.push('');

  lines.push('## Cost estimate basis');
  lines.push('');
  lines.push(`Developer estimate ${money(e.estimatedCosts.developerCost)}, operating ${money(e.estimatedCosts.opsCost)}.`);
  for (const m of e.estimatedCosts.multipliers || []) lines.push(`- ${m}`);
  lines.push('');

  lines.push('## Cash flow');
  lines.push('');
  lines.push(`Solvent: **${e.cashFlow.solvent ? 'yes' : 'NO'}** — lowest balance ${money(e.cashFlow.lowestBalance)}, final ${money(e.cashFlow.finalBalance)}.`);
  lines.push('');
  lines.push('| Event | Amount | Running balance |');
  lines.push('|---|---|---|');
  for (const row of e.cashFlow.ledger) {
    lines.push(`| ${row.event} | ${row.amount < 0 ? `(${money(Math.abs(row.amount))})` : money(row.amount)} | ${money(row.balance)} |`);
  }
  lines.push('');

  lines.push('## Milestones');
  lines.push('');
  lines.push('| # | Milestone | Owner | Fixed price | Tickets | Acceptance tests |');
  lines.push('|---|---|---|---|---|---|');
  for (const [i, m] of e.deliveryPlan.milestones.entries()) {
    lines.push(`| ${i + 1} | ${m.name} | ${m.ownedBy} | ${m.developerPayout > 0 ? money(m.developerPayout) : '—'} | ${m.tickets.length} | ${m.acceptanceTests.length} |`);
  }
  lines.push('');
  lines.push(`Total allocated to milestones: ${money(e.deliveryPlan.allocatedToMilestones)} of ${money(e.deliveryPlan.developerBudget)} budget.`);
  lines.push('');

  lines.push('## Tickets');
  lines.push('');
  lines.push('| Ticket | Fixed price | Access tier | Downgraded |');
  lines.push('|---|---|---|---|');
  for (const t of e.deliveryPlan.tickets) {
    lines.push(`| \`${t.id}\` | ${money(t.fixedPrice)} | ${t.accessPlan.effectiveTier} | ${t.accessPlan.downgraded ? `yes (from ${t.accessPlan.requestedTier})` : 'no'} |`);
  }
  lines.push('');

  lines.push('## Contractor access');
  lines.push('');
  lines.push(`Tiers in use: ${e.access.tiersInUse.join(', ')}`);
  lines.push('');
  lines.push(`Agreements required before any assignment: ${e.access.requiredAgreements.join(', ')}`);
  lines.push('');
  if (e.access.complianceFlags.length) {
    lines.push(`Compliance flags: ${e.access.complianceFlags.join(', ')}`);
    lines.push('');
  }
  lines.push('Never granted to a contractor on this engagement:');
  lines.push('');
  for (const d of e.access.neverGranted) lines.push(`- ${d}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * A single contractor-facing ticket, shaped like the repo's own issue template
 * so it can be opened as a GitHub issue directly.
 *
 * Note what is absent: the client's name, the client's price, and every other
 * ticket's price. The contractor needs the work and their own fixed price. The
 * commercial context is not theirs, and sharing it is how a contractor learns
 * what to charge the client directly.
 */
function buildTicketIssue(ticket, engagement) {
  if (!ticket || !ticket.id) throw new TypeError('A ticket is required.');
  if (!ticket.accessPlan) throw new Error(`Ticket ${ticket.id} has no access plan.`);
  const lines = [];
  lines.push(`# ${ticket.title}`);
  lines.push('');
  lines.push(`**Ticket:** \`${ticket.id}\`  `);
  lines.push(`**Milestone:** ${ticket.milestoneId}  `);
  lines.push(`**Fixed price:** $${Math.round(ticket.fixedPrice).toLocaleString('en-US')} — paid on acceptance, not on hours.`);
  lines.push('');
  lines.push('## Goal');
  lines.push('');
  lines.push(ticket.summary);
  lines.push('');
  lines.push('## Acceptance criteria');
  lines.push('');
  lines.push('Every box must be objectively true. If a criterion is ambiguous, ask on this ticket before building — do not interpret it.');
  lines.push('');
  for (const c of ticket.acceptanceCriteria) lines.push(`- [ ] ${c}`);
  lines.push('');
  lines.push('## Definition of done');
  lines.push('');
  lines.push('- [ ] All acceptance criteria met');
  lines.push('- [ ] Automated tests added and passing in CI');
  lines.push('- [ ] Pull request opened against the integration branch (do not merge)');
  lines.push('- [ ] No credential, key or token anywhere in the diff');
  lines.push('- [ ] Ready for our review');
  lines.push('');
  lines.push('## Access for this ticket');
  lines.push('');
  lines.push(`Tier: **${ticket.accessPlan.effectiveTier}**`);
  lines.push('');
  for (const g of ticket.accessPlan.grants) lines.push(`- ${g}`);
  lines.push('');
  if (ticket.accessPlan.restrictions.length) {
    lines.push('**Restrictions on this engagement:**');
    lines.push('');
    for (const r of ticket.accessPlan.restrictions) lines.push(`- ${r}`);
    lines.push('');
  }
  lines.push('Not available on this ticket, and not requestable: production data or credentials, deployment to production, merge rights, repository settings, and any direct contact with the end client. If you believe the ticket cannot be completed without one of these, say so here and we will either re-scope it or run that step ourselves.');
  lines.push('');
  lines.push('## Working agreement');
  lines.push('');
  lines.push('- Fixed price on acceptance. No hourly billing, no scope added without a new ticket.');
  lines.push('- All communication stays on this ticket.');
  lines.push('- Do not contact, quote, invoice or propose work to the end client.');
  lines.push('- Do not subcontract this ticket without written approval.');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  INTERNAL_TERMS,
  assertNoInternalLeakage,
  buildProposal,
  buildInternalPlan,
  buildTicketIssue,
};

'use strict';

// Portfolio roll-up across every engagement ledger.
//
// The three questions this answers, which no single engagement can:
//
//   1. Is the pipeline real? Weighted, not gross — a stack of unsigned proposals
//      is not revenue, and planning spend against it is how agencies die with a
//      full pipeline.
//   2. Where is the cash? Deposits held against contractor payouts still owed.
//      A profitable agency can still fail this test.
//   3. Are our estimates any good? Actual delivery cost against planned, across
//      closed engagements. This is the number that improves future quotes, and
//      it is invisible without a ledger.
//
// Pure: takes an array of ledgers, returns a report. Reading them off disk is
// ledger-store.js's job.

const { economics, PIPELINE_WEIGHTS, TERMINAL } = require('./ledger');
const { disputeStats } = require('./arbitration');

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
}

const ACTIVE_BUILD_STATES = Object.freeze(['won', 'in_delivery']);
const OPEN_PIPELINE_STATES = Object.freeze(['qualified', 'proposed']);
// States where contractor money may still be owed. `delivered` belongs here:
// the client has accepted everything, but a final payout often has not cleared,
// and leaving it out overstates free cash at exactly the wrong moment.
const CONTRACTOR_LIABILITY_STATES = Object.freeze(['won', 'in_delivery', 'delivered']);

/**
 * Summarise a set of ledgers.
 *
 * `weightedPipeline` applies ledger.PIPELINE_WEIGHTS to the unsigned states
 * only; won and later are counted at full value in `contractedValue` instead, so
 * nothing is double-counted between the two.
 */
function summarize(ledgers = []) {
  const byState = {};
  let grossPipeline = 0;      // unsigned only
  let weightedPipeline = 0;   // unsigned only, probability-weighted
  let contractedValue = 0;    // won and beyond
  let cashHeld = 0;
  let collected = 0;
  let paidOut = 0;
  let opsSpent = 0;
  let retainerMonthly = 0;      // contracted rate, not cash
  let retainerCollected = 0;    // cash actually received
  let committedToContractors = 0; // accepted-but-unpaid plus not-yet-accepted work

  const attention = [];
  const closedVariances = [];

  for (const ledger of ledgers) {
    byState[ledger.state] = (byState[ledger.state] || 0) + 1;
    const e = economics(ledger);

    collected = round(collected + e.received);
    retainerCollected = round(retainerCollected + e.retainerReceived);
    paidOut = round(paidOut + e.developerPaid);
    opsSpent = round(opsSpent + e.opsSpent);
    cashHeld = round(cashHeld + e.cashPosition);

    if (!ledger.planned) continue;

    if (OPEN_PIPELINE_STATES.includes(ledger.state)) {
      grossPipeline = round(grossPipeline + ledger.planned.projectPrice);
      weightedPipeline = round(weightedPipeline + ledger.planned.projectPrice * (PIPELINE_WEIGHTS[ledger.state] || 0));
    } else if (!TERMINAL.includes(ledger.state) || ledger.state === 'closed') {
      contractedValue = round(contractedValue + ledger.planned.projectPrice);
    }

    if (CONTRACTOR_LIABILITY_STATES.includes(ledger.state)) {
      // Everything still owed to contractors on live builds: the planned payout
      // for unaccepted milestones plus anything accepted and not yet paid.
      const owed = ledger.planned.milestones.reduce((sum, pm) => {
        const tracked = ledger.milestones.find((m) => m.id === pm.id);
        if (!tracked) return sum;
        if (tracked.paid) return sum;
        return sum + pm.developerPayout;
      }, 0);
      committedToContractors = round(committedToContractors + owed);
    }

    if (ledger.state === 'closed' || ledger.state === 'delivered') {
      retainerMonthly = round(retainerMonthly + (ledger.planned.monthlyRetainer || 0));
      if (e.variance) closedVariances.push({ clientRef: ledger.clientRef, ...e.variance, plannedDeveloperCost: ledger.planned.developerCost, actualDeveloperCost: e.developerPaid });
    }

    // Things a human needs to act on.
    if (e.cashPosition < 0) {
      attention.push({ clientRef: ledger.clientRef, severity: 'high', issue: `Cash position is negative ($${e.cashPosition}) — we are funding this build.` });
    }
    if (e.unpaidAcceptedMilestones.length) {
      attention.push({ clientRef: ledger.clientRef, severity: 'medium', issue: `Accepted but unpaid: ${e.unpaidAcceptedMilestones.join(', ')}.` });
    }
    if (ledger.state === 'delivered' && e.outstandingFromClient > 0) {
      attention.push({ clientRef: ledger.clientRef, severity: 'high', issue: `Delivered with $${e.outstandingFromClient} still outstanding from the client.` });
    }
    if (ledger.state === 'proposed' && ledger.proposalSentAt) {
      const days = Math.floor((Date.now() - new Date(ledger.proposalSentAt).getTime()) / 86400000);
      if (days >= 14) {
        attention.push({ clientRef: ledger.clientRef, severity: 'low', issue: `Proposal out ${days} days with no deposit. Close it or mark it lost.` });
      }
    }
  }

  // Cash runway against contractor commitments: the question "if every live
  // build finished tomorrow, could we pay everyone from cash on hand?"
  const coversCommitments = cashHeld >= committedToContractors;

  const wonCount = ledgers.filter((l) => !['qualified', 'proposed', 'lost', 'disqualified'].includes(l.state)).length;
  // Win rate is measured over deals that were actually proposed and then decided.
  // A prospect we disqualified was never winnable, so counting it as a loss
  // understates how well the proposals we do send are converting.
  const decided = ledgers.filter((l) => !['qualified', 'proposed', 'disqualified'].includes(l.state)).length;

  return {
    engagements: ledgers.length,
    byState,
    pipeline: {
      grossPipeline,
      weightedPipeline,
      contractedValue,
      openCount: ledgers.filter((l) => OPEN_PIPELINE_STATES.includes(l.state)).length,
    },
    cash: {
      collected,
      paidOut,
      opsSpent,
      cashHeld,
      committedToContractors,
      coversCommitments,
      uncommittedCash: round(cashHeld - committedToContractors),
    },
    recurring: {
      // contractedMonthly is what the delivered engagements are signed up for.
      // collected is what has actually arrived. Reporting the first as though it
      // were the second is how a retainer book looks healthier than it is.
      contractedMonthly: retainerMonthly,
      annualisedContracted: round(retainerMonthly * 12),
      collected: retainerCollected,
    },
    conversion: {
      decided,
      won: wonCount,
      // Win rate over decided outcomes only. Counting still-open proposals as
      // losses makes a healthy pipeline look like a failing one.
      winRatePct: decided > 0 ? round((wonCount / decided) * 100, 1) : null,
    },
    estimateAccuracy: estimateAccuracy(closedVariances),
    // Disputes belong in the portfolio view because an overdue one is an unpaid
    // contractor, and a pattern of overturns is a defect in our own gate.
    disputes: disputeStats(ledgers),
    attention: attention.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity])),
  };
}

/**
 * How good our delivery-cost estimates are, over finished engagements.
 *
 * A consistently positive mean overrun means the planning numbers in
 * engagement.js are too low and every future quote is underpriced. That is the
 * whole reason for recording actuals.
 */
function estimateAccuracy(variances) {
  if (!variances.length) {
    return { sample: 0, meanVariance: null, meanVariancePct: null, verdict: 'No finished engagements yet — estimates are unvalidated.' };
  }
  const total = variances.reduce((sum, v) => sum + v.developerCost, 0);
  const mean = round(total / variances.length);
  const pctSum = variances.reduce((sum, v) => sum + (v.plannedDeveloperCost > 0 ? (v.developerCost / v.plannedDeveloperCost) * 100 : 0), 0);
  const meanPct = round(pctSum / variances.length, 1);

  let verdict;
  if (Math.abs(meanPct) <= 5) verdict = 'Estimates are holding. Leave the planning numbers alone.';
  else if (meanPct > 5) verdict = `Delivery is running ${meanPct}% over estimate. Raise DEVELOPER_COST_PER_CAPABILITY in engagement.js — every open quote is underpriced until you do.`;
  else verdict = `Delivery is running ${Math.abs(meanPct)}% under estimate. The planning numbers are conservative; lowering them wins more deals at the same margin.`;

  return { sample: variances.length, meanVariance: mean, meanVariancePct: meanPct, verdict, detail: variances };
}

/** Markdown report for the portfolio. Internal only — it carries cost and margin. */
function renderReport(ledgers = []) {
  const s = summarize(ledgers);
  const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
  const lines = [];

  lines.push('# INTERNAL — Agency portfolio');
  lines.push('');
  lines.push('> Internal only. Carries delivery cost and margin.');
  lines.push('');

  if (!s.engagements) {
    lines.push('No engagements on record yet. Open one with `npm run agency:plan -- --client <file> --open`.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`**${s.engagements} engagement(s)** — ${Object.entries(s.byState).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  lines.push('');

  lines.push('## Pipeline');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Open opportunities | ${s.pipeline.openCount} |`);
  lines.push(`| Gross (unsigned) | ${money(s.pipeline.grossPipeline)} |`);
  lines.push(`| **Weighted (unsigned)** | **${money(s.pipeline.weightedPipeline)}** |`);
  lines.push(`| Contracted (signed and beyond) | ${money(s.pipeline.contractedValue)} |`);
  if (s.conversion.winRatePct !== null) {
    lines.push(`| Win rate (of ${s.conversion.decided} decided) | ${s.conversion.winRatePct}% |`);
  }
  lines.push('');
  lines.push('Weighted pipeline counts unsigned work only, at 10% qualified / 30% proposed. Do not plan spending against the gross figure.');
  lines.push('');

  lines.push('## Cash');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Collected from clients | ${money(s.cash.collected)} |`);
  lines.push(`| Paid to contractors | (${money(s.cash.paidOut)}) |`);
  lines.push(`| Software / operating | (${money(s.cash.opsSpent)}) |`);
  lines.push(`| **Cash held** | **${money(s.cash.cashHeld)}** |`);
  lines.push(`| Still committed to contractors | ${money(s.cash.committedToContractors)} |`);
  lines.push(`| Uncommitted | ${money(s.cash.uncommittedCash)} |`);
  lines.push('');
  lines.push(s.cash.coversCommitments
    ? '✅ Cash on hand covers every outstanding contractor commitment.'
    : `⚠️ Cash on hand does NOT cover outstanding contractor commitments — short by ${money(Math.abs(s.cash.uncommittedCash))}. Collect a balance or slow an assignment.`);
  lines.push('');

  if (s.recurring.contractedMonthly > 0 || s.recurring.collected > 0) {
    lines.push('## Recurring');
    lines.push('');
    lines.push(`Contracted: ${money(s.recurring.contractedMonthly)}/month across delivered engagements (${money(s.recurring.annualisedContracted)} annualised).`);
    lines.push(`Collected to date: ${money(s.recurring.collected)}.`);
    if (s.recurring.collected === 0 && s.recurring.contractedMonthly > 0) {
      lines.push('');
      lines.push('⚠️ Contracted retainer with nothing collected yet — invoice it. A retainer nobody bills is not revenue.');
    }
    lines.push('');
  }

  lines.push('## Estimate accuracy');
  lines.push('');
  lines.push(s.estimateAccuracy.verdict);
  lines.push('');
  if (s.estimateAccuracy.sample) {
    lines.push('| Engagement | Planned delivery | Actual | Variance |');
    lines.push('|---|---|---|---|');
    for (const v of s.estimateAccuracy.detail) {
      lines.push(`| ${v.clientRef} | ${money(v.plannedDeveloperCost)} | ${money(v.actualDeveloperCost)} | ${v.developerCost >= 0 ? '+' : ''}${money(v.developerCost)} |`);
    }
    lines.push('');
  }

  if (s.disputes.total > 0) {
    lines.push('## Disputes');
    lines.push('');
    lines.push(`${s.disputes.total} total — ${s.disputes.open} open${s.disputes.overdue ? ` (${s.disputes.overdue} OVERDUE)` : ''}, ${s.disputes.decided} decided${s.disputes.escalated ? `, ${s.disputes.escalated} escalated` : ''}.`);
    if (Object.keys(s.disputes.outcomes).length) {
      lines.push('');
      lines.push(Object.entries(s.disputes.outcomes).map(([k, v]) => `${v} ${k}`).join(', ') + '.');
    }
    if (s.disputes.overturnRate !== null) {
      lines.push('');
      lines.push(`Overturn rate ${Math.round(s.disputes.overturnRate * 100)}%, spec-defect rate ${Math.round(s.disputes.specDefectRate * 100)}%. Read both as findings about us, not about contractors.`);
    }
    for (const f of s.disputes.findings) {
      lines.push('');
      lines.push(`⚠️ ${f}`);
    }
    lines.push('');
  }

  if (s.attention.length) {
    lines.push('## Needs attention');
    lines.push('');
    for (const a of s.attention) {
      const mark = { high: '🔴', medium: '🟡', low: '⚪' }[a.severity];
      lines.push(`- ${mark} **${a.clientRef}** — ${a.issue}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  ACTIVE_BUILD_STATES,
  OPEN_PIPELINE_STATES,
  CONTRACTOR_LIABILITY_STATES,
  summarize,
  estimateAccuracy,
  renderReport,
};

'use strict';

// The contractor bench — the fulfilment department as an actual roster.
//
// contractor.js gates ONE assignment: is this person papered, and may they hold
// this ticket's access tier. It answers nothing about the bench as a whole,
// which is where the real operational failures live:
//
//   - Assigning a sixth concurrent ticket to the one person who always says yes.
//     Nothing rejects it, so the deadline slips silently and we find out at the
//     milestone review.
//   - Assigning follow-up work to whoever is cheapest, when their last two
//     tickets each failed quality control twice. Rework costs more than the fixed
//     price saved, and that cost is invisible unless someone counts it.
//   - Running four builds through one contractor, so a single person's illness
//     stalls the whole book.
//
// Track record and current load are both DERIVED FROM THE LEDGERS rather than
// stored on the contractor record. A hand-maintained "tickets completed: 12"
// field drifts from reality within a month; a count over the assignments people
// actually recorded cannot.

const { assignmentEligibility } = require('./contractor');
const { CAPABILITIES } = require('./offer');

// What a contractor can be cleared to build: the offer's capabilities, plus the
// launch-hardening work that is not a capability of its own. Validated on the way
// in, so a typo ("reporting-dashboard") fails at the bench rather than silently
// making someone ineligible for every ticket they were hired for.
const ASSIGNABLE_CAPABILITIES = Object.freeze([...CAPABILITIES.map((c) => c.id), 'launch-hardening']);

// Default ceiling on concurrent tickets per contractor. Deliberately low: these
// are narrow, few-day tickets, and a contractor juggling five of ours is almost
// certainly juggling other clients' too.
const DEFAULT_MAX_CONCURRENT = 3;

// A contractor holding more than this share of all live work is a single point
// of failure for the book, whatever their reliability.
const CONCENTRATION_WARNING = 0.5;

// Concentration is meaningless below a few live tickets — "holds 1 of 1 (100%)"
// is arithmetically true and operationally noise. A warning that fires on every
// first assignment is one people learn to scroll past.
const CONCENTRATION_MIN_TICKETS = 3;

// Outcomes that count as the contractor having needed a second pass.
const REWORK_OUTCOMES = Object.freeze(['completed-after-rework']);
const FAILED_OUTCOMES = Object.freeze(['reassigned', 'abandoned']);

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
}

function newBench() {
  return { contractors: [] };
}

/**
 * Add or replace a contractor on the bench.
 *
 * `capabilities` are the offer's capability ids (see offer.js) they can build.
 * An empty list means "not yet cleared for anything" rather than "anything" —
 * the permissive reading is how someone ends up on a calendar integration
 * having only ever written form handlers.
 */
function upsertContractor(bench, contractor) {
  if (!contractor || !contractor.id) throw new TypeError('contractor.id is required.');
  const capabilities = Array.isArray(contractor.capabilities) ? [...contractor.capabilities] : [];
  const unknown = capabilities.filter((c) => !ASSIGNABLE_CAPABILITIES.includes(c));
  if (unknown.length) {
    throw new Error(`Unknown capability id(s) for ${contractor.id}: ${unknown.join(', ')}. Expected one of ${ASSIGNABLE_CAPABILITIES.join(', ')}.`);
  }
  const record = {
    id: contractor.id,
    name: contractor.name || contractor.id,
    capabilities,
    maxConcurrent: Number.isFinite(Number(contractor.maxConcurrent)) && Number(contractor.maxConcurrent) > 0
      ? Number(contractor.maxConcurrent)
      : DEFAULT_MAX_CONCURRENT,
    agreements: contractor.agreements || {},
    paymentDetailsOnFile: contractor.paymentDetailsOnFile !== false,
    suspended: contractor.suspended === true,
    notes: contractor.notes || null,
  };
  const index = bench.contractors.findIndex((c) => c.id === record.id);
  if (index >= 0) bench.contractors[index] = record;
  else bench.contractors.push(record);
  return bench;
}

function getContractor(bench, id) {
  return bench.contractors.find((c) => c.id === id) || null;
}

/**
 * Is this contractor papered for ordinary work, independent of any one ticket?
 * Used by the bench report, where showing free capacity for someone who cannot
 * legally be assigned anything is worse than showing nothing.
 */
function paperworkStatus(contractor, { asOf = new Date() } = {}) {
  return assignmentEligibility(contractor, [], { asOf });
}

function allAssignments(ledgers = []) {
  return ledgers.flatMap((l) => (l.assignments || []).map((a) => ({ ...a, clientRef: l.clientRef })));
}

/** Tickets a contractor is holding right now, across every engagement. */
function currentLoad(contractorId, ledgers = []) {
  return allAssignments(ledgers).filter((a) => a.contractorId === contractorId && !a.releasedAt);
}

/**
 * A contractor's track record, counted from closed-out assignments.
 *
 * `firstPassRate` is the headline number and is deliberately the one we rank on.
 * Work that passes quality control the first time is the whole economic case for
 * a managed bench: a ticket that comes back twice has consumed our review time
 * three times over, which is our margin, not theirs.
 */
function performanceOf(contractorId, ledgers = []) {
  const closed = allAssignments(ledgers).filter((a) => a.contractorId === contractorId && a.releasedAt);
  const completed = closed.filter((a) => a.outcome === 'completed').length;
  const rework = closed.filter((a) => REWORK_OUTCOMES.includes(a.outcome)).length;
  const failed = closed.filter((a) => FAILED_OUTCOMES.includes(a.outcome)).length;
  const total = closed.length;

  // Cost variance on the milestones this contractor was paid for.
  const payments = ledgers.flatMap((l) => (l.payments || []).filter((p) => p.contractorId === contractorId));
  const costVariance = round(payments.reduce((sum, p) => sum + (p.variance || 0), 0));

  return {
    contractorId,
    ticketsClosed: total,
    completedFirstPass: completed,
    neededRework: rework,
    failedOrReassigned: failed,
    firstPassRate: total > 0 ? round(completed / total, 3) : null,
    milestonesPaid: payments.length,
    costVariance,
    // Unproven is not the same as bad. It is surfaced so a first assignment is a
    // deliberate choice rather than an accident.
    proven: total >= 3,
  };
}

/**
 * Can this contractor take this ticket right now? Every blocker is named, so a
 * "no" is actionable rather than mysterious.
 */
function eligibilityFor(bench, contractorId, ticket, ledgers = [], { asOf = new Date() } = {}) {
  const contractor = getContractor(bench, contractorId);
  if (!contractor) {
    return { contractorId, assignable: false, blockers: [`${contractorId} is not on the bench.`], load: 0, capacity: 0 };
  }
  if (!ticket || !ticket.accessPlan) {
    throw new Error('A ticket built through buildDeliveryPlan() is required — it carries the access plan.');
  }

  const blockers = [];

  // Paperwork, delegated to the existing gate so there is one rule, not two.
  const papered = assignmentEligibility(contractor, ticket.accessPlan.requiredAgreements, { asOf });
  if (!papered.eligible) blockers.push(...papered.blockers);

  // Capability match.
  const needed = ticket.milestoneId;
  if (needed && !contractor.capabilities.includes(needed)) {
    blockers.push(`Not cleared for ${needed}. Cleared for: ${contractor.capabilities.length ? contractor.capabilities.join(', ') : 'nothing yet'}.`);
  }

  // Capacity.
  const load = currentLoad(contractorId, ledgers).length;
  if (load >= contractor.maxConcurrent) {
    blockers.push(`At capacity: holding ${load} of a maximum ${contractor.maxConcurrent} concurrent tickets.`);
  }

  // Already holding this exact ticket.
  if (currentLoad(contractorId, ledgers).some((a) => a.ticketId === ticket.id)) {
    blockers.push(`Already holding ${ticket.id}.`);
  }

  return {
    contractorId,
    name: contractor.name,
    assignable: blockers.length === 0,
    blockers,
    load,
    capacity: contractor.maxConcurrent,
    headroom: Math.max(contractor.maxConcurrent - load, 0),
    performance: performanceOf(contractorId, ledgers),
  };
}

/**
 * Who should take this ticket?
 *
 * Ranking, in order: proven first-pass reliability, then headroom, then cost
 * variance. Cost is last deliberately — picking the cheapest contractor whose
 * work comes back twice is a false economy, and this is where that mistake would
 * otherwise get made.
 *
 * Returns the ranked assignable candidates plus everyone who was excluded and
 * why, because "nobody is available" is a scheduling fact the owner needs to see,
 * not an empty array.
 */
function recommendAssignee(bench, ticket, ledgers = [], options = {}) {
  const assessments = bench.contractors.map((c) => eligibilityFor(bench, c.id, ticket, ledgers, options));
  const available = assessments.filter((a) => a.assignable);
  const excluded = assessments.filter((a) => !a.assignable);

  const ranked = available.sort((a, b) => {
    // An unproven contractor sorts below a proven one, but above nobody.
    const aRate = a.performance.firstPassRate === null ? 0.5 : a.performance.firstPassRate;
    const bRate = b.performance.firstPassRate === null ? 0.5 : b.performance.firstPassRate;
    if (bRate !== aRate) return bRate - aRate;
    if (b.headroom !== a.headroom) return b.headroom - a.headroom;
    return a.performance.costVariance - b.performance.costVariance;
  });

  return {
    ticketId: ticket.id,
    recommended: ranked[0] || null,
    ranked,
    excluded,
    reason: ranked.length
      ? `${ranked[0].name}: ${ranked[0].performance.proven ? `${Math.round(ranked[0].performance.firstPassRate * 100)}% first-pass over ${ranked[0].performance.ticketsClosed} tickets` : 'no track record yet'}, ${ranked[0].headroom} slot(s) free.`
      : `Nobody on the bench can take ${ticket.id} right now. ${excluded.length} contractor(s) excluded — see blockers.`,
  };
}

/**
 * Bench-wide capacity and concentration risk.
 */
function capacity(bench, ledgers = []) {
  const active = bench.contractors.filter((c) => !c.suspended);
  // Only papered contractors contribute usable capacity. Counting an unsigned
  // contractor's slots makes the bench look able to absorb work it cannot
  // legally take, which is the number a "can we sell another build" decision
  // would be made on.
  const assignable = active.filter((c) => paperworkStatus(c).eligible);
  const totalCapacity = assignable.reduce((sum, c) => sum + c.maxConcurrent, 0);
  const open = allAssignments(ledgers).filter((a) => !a.releasedAt);
  const inUse = open.length;

  const byContractor = assignable.map((c) => {
    const load = open.filter((a) => a.contractorId === c.id).length;
    return { contractorId: c.id, name: c.name, load, capacity: c.maxConcurrent, headroom: Math.max(c.maxConcurrent - load, 0) };
  }).sort((a, b) => b.load - a.load);

  const warnings = [];
  if (inUse >= CONCENTRATION_MIN_TICKETS) {
    const top = byContractor[0];
    if (top && top.load / inUse > CONCENTRATION_WARNING) {
      warnings.push(`${top.name} holds ${top.load} of ${inUse} live tickets (${Math.round((top.load / inUse) * 100)}%). One person's absence stalls the book — spread the next assignment.`);
    }
  }
  if (totalCapacity > 0 && inUse / totalCapacity > 0.85) {
    warnings.push(`Bench is ${Math.round((inUse / totalCapacity) * 100)}% committed. Win another deal now and there is nobody to build it — recruit before selling.`);
  }
  if (assignable.length === 0) {
    warnings.push(active.length
      ? 'No contractor on the bench has complete paperwork. Nothing can be assigned until an NDA, IP assignment and non-solicit are signed.'
      : 'No active contractors on the bench. Nothing can be assigned.');
  } else if (assignable.length < 2) {
    warnings.push('Only one assignable contractor. Every engagement is a single point of failure.');
  }

  // Assignments held by someone no longer on the bench, or suspended.
  const benchIds = new Set(bench.contractors.filter((c) => !c.suspended).map((c) => c.id));
  const orphaned = open.filter((a) => !benchIds.has(a.contractorId));
  for (const a of orphaned) {
    warnings.push(`Ticket ${a.ticketId} (${a.clientRef}) is held by ${a.contractorId}, who is suspended or off the bench. Reassign it.`);
  }

  return {
    contractors: active.length,
    assignableContractors: assignable.length,
    totalCapacity,
    inUse,
    headroom: Math.max(totalCapacity - inUse, 0),
    utilisationPct: totalCapacity > 0 ? round((inUse / totalCapacity) * 100, 1) : 0,
    byContractor,
    orphanedAssignments: orphaned,
    warnings,
  };
}

/** Internal bench report. Carries contractor names and rates — never client-facing. */
function renderBench(bench, ledgers = []) {
  const cap = capacity(bench, ledgers);
  const lines = [];
  lines.push('# INTERNAL — Contractor bench');
  lines.push('');
  lines.push('> Internal only. Names, capacity and performance.');
  lines.push('');

  if (!bench.contractors.length) {
    lines.push('Nobody on the bench yet. Add a contractor once their NDA, IP assignment and non-solicit are signed.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`**${cap.contractors} active contractor(s)** — ${cap.inUse} of ${cap.totalCapacity} concurrent slots in use (${cap.utilisationPct}%).`);
  lines.push('');
  lines.push('| Contractor | Cleared for | Load | Free | First-pass | Tickets | Cost variance |');
  lines.push('|---|---|---|---|---|---|---|');
  const unpapered = [];
  for (const c of bench.contractors) {
    const perf = performanceOf(c.id, ledgers);
    const load = currentLoad(c.id, ledgers).length;
    const papers = paperworkStatus(c);
    if (!papers.eligible && !c.suspended) unpapered.push({ contractor: c, papers });
    const rate = perf.firstPassRate === null ? '—' : `${Math.round(perf.firstPassRate * 100)}%`;
    const variance = perf.costVariance === 0 ? '—' : `${perf.costVariance > 0 ? '+' : ''}$${Math.abs(perf.costVariance).toLocaleString('en-US')}`;
    // Free capacity is only real if they can actually be assigned. Printing "2
    // free" next to someone whose IP assignment is unsigned invites exactly the
    // assignment the paperwork gate exists to stop.
    let free;
    if (c.suspended) free = 'suspended';
    else if (!papers.eligible) free = 'blocked';
    else free = String(Math.max(c.maxConcurrent - load, 0));
    lines.push(`| ${c.name}${c.suspended ? ' *(suspended)*' : ''} | ${c.capabilities.length ? c.capabilities.join(', ') : '—'} | ${load} | ${free} | ${rate} | ${perf.ticketsClosed} | ${variance} |`);
  }
  lines.push('');

  if (unpapered.length) {
    lines.push('**Cannot be assigned — paperwork outstanding:**');
    lines.push('');
    for (const u of unpapered) {
      lines.push(`- ${u.contractor.name} — ${u.papers.blockers.join(' ')}`);
    }
    lines.push('');
  }

  const unproven = bench.contractors.filter((c) => !c.suspended && !performanceOf(c.id, ledgers).proven);
  if (unproven.length) {
    lines.push(`Unproven, under 3 closed tickets: ${unproven.map((c) => c.name).join(', ')} — not a mark against them, but give a first ticket deliberately rather than by accident.`);
    lines.push('');
  }

  if (cap.warnings.length) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of cap.warnings) lines.push(`- ⚠️ ${w}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  ASSIGNABLE_CAPABILITIES,
  DEFAULT_MAX_CONCURRENT,
  CONCENTRATION_WARNING,
  CONCENTRATION_MIN_TICKETS,
  REWORK_OUTCOMES,
  FAILED_OUTCOMES,
  newBench,
  upsertContractor,
  getContractor,
  paperworkStatus,
  currentLoad,
  performanceOf,
  eligibilityFor,
  recommendAssignee,
  capacity,
  renderBench,
};

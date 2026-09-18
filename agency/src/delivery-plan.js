'use strict';

// Step 2: architecture. This is the part that is not delegable, because it is
// what makes the delegation safe.
//
// The unit of work handed to a contractor is a TICKET, and a ticket is only
// safe to hand over when it carries four things:
//   1. a narrow, single-purpose statement of work
//   2. objective acceptance criteria — testable without a conversation
//   3. a fixed price (never an hourly rate)
//   4. the lowest access tier that can complete it
//
// A ticket missing any of the four is rejected by buildDeliveryPlan() rather
// than shipped to a developer. That is the whole quality-control thesis: we
// never ask a contractor to interpret intent, so their output is verifiable and
// our margin is predictable.
//
// Fixed-price milestones, not hours: the client bought an outcome, so we buy
// outcomes too. Hourly contractor billing transfers scope risk onto us while
// leaving the estimate open-ended.

const { resolveCapabilities } = require('./offer');
const { accessPlanForTicket } = require('./access');

// Share of the developer budget each milestone carries, before normalisation
// over the milestones actually included in this build.
const MILESTONE_WEIGHTS = Object.freeze({
  'discovery-architecture': 0,     // ours; no contractor payout
  'lead-capture': 20,
  'follow-up': 22,
  'qualification': 18,
  'scheduling': 12,
  'reporting': 18,
  'launch-hardening': 10,
});

// Ticket templates per capability. Deliberately small: a ticket a contractor can
// finish and have accepted inside a few days is a ticket that cannot quietly
// drift for three weeks.
const TICKET_TEMPLATES = Object.freeze({
  'lead-capture': Object.freeze([
    Object.freeze({
      slug: 'intake-endpoints',
      title: 'Build lead intake endpoints for the agreed channels',
      summary: 'One normalised intake path per agreed channel (web form, phone/SMS, email, chat, marketplace). Each writes a canonical lead record.',
      acceptanceCriteria: Object.freeze([
        'Every agreed channel has an intake path that produces a canonical lead record.',
        'Malformed and duplicate submissions are rejected or deduped, never silently dropped.',
        'Automated tests cover one success and one rejection case per channel.',
      ]),
      accessTier: 'sandbox',
      weight: 55,
    }),
    Object.freeze({
      slug: 'capture-audit-log',
      title: 'Append-only capture audit log',
      summary: 'Every inbound lead is recorded with source, timestamp and outcome so "we never got that lead" is answerable with data.',
      acceptanceCriteria: Object.freeze([
        'Each intake writes exactly one immutable audit row.',
        'The log is queryable by source and date range.',
        'A dropped or failed intake is recorded as such rather than absent.',
      ]),
      accessTier: 'sandbox',
      weight: 45,
    }),
  ]),
  'follow-up': Object.freeze([
    Object.freeze({
      slug: 'sequence-engine',
      title: 'Timed follow-up sequence engine',
      summary: 'Schedule and advance a multi-touch sequence per lead; stop on reply, booking, or opt-out.',
      acceptanceCriteria: Object.freeze([
        'A new lead is enrolled and the first touch is scheduled within the agreed interval.',
        'Reply, booking and opt-out each halt the sequence immediately.',
        'A lead can never be enrolled twice concurrently.',
        'Tests cover enrolment, advance, halt-on-reply and halt-on-opt-out.',
      ]),
      accessTier: 'sandbox',
      weight: 45,
    }),
    Object.freeze({
      slug: 'message-composition',
      title: 'Message composition with per-client template set',
      summary: 'Compose each touch from the client-approved template set with lead-specific fields.',
      acceptanceCriteria: Object.freeze([
        'Every outbound touch renders from an approved template — no free-text generation reaches a recipient unreviewed.',
        'Missing personalisation fields fail closed rather than rendering an empty placeholder.',
        'Opt-out language is present on every channel that legally requires it.',
      ]),
      accessTier: 'sandbox',
      weight: 30,
    }),
    Object.freeze({
      slug: 'suppression-consent',
      title: 'Suppression list and consent enforcement',
      summary: 'Honour opt-outs, quiet hours and consent state before any send is attempted.',
      acceptanceCriteria: Object.freeze([
        'A suppressed or non-consented contact is never sent to, and the block is logged with a reason.',
        'Quiet-hours logic uses recipient local time and fails closed when the timezone is unknown.',
        'Tests prove a suppressed contact cannot be sent to through any code path.',
      ]),
      accessTier: 'sandbox',
      weight: 25,
    }),
  ]),
  qualification: Object.freeze([
    Object.freeze({
      slug: 'scoring-model',
      title: 'Lead scoring and qualification rules',
      summary: 'Score each lead against the criteria agreed in discovery and assign a qualification band.',
      acceptanceCriteria: Object.freeze([
        'Scoring is deterministic: the same lead input always produces the same score and band.',
        'Every score is explainable — the contributing factors are returned with it.',
        'The agreed disqualifying conditions override a high score.',
      ]),
      accessTier: 'sandbox',
      weight: 55,
    }),
    Object.freeze({
      slug: 'routing-rules',
      title: 'Routing and assignment rules',
      summary: 'Route each qualified lead to the correct person, team or queue with an escalation path.',
      acceptanceCriteria: Object.freeze([
        'Each qualification band routes to the destination agreed in the scope document.',
        'An unroutable lead escalates to a named fallback instead of being orphaned.',
        'Routing decisions are logged with the rule that fired.',
      ]),
      accessTier: 'sandbox',
      weight: 45,
    }),
  ]),
  scheduling: Object.freeze([
    Object.freeze({
      slug: 'calendar-integration',
      title: 'Calendar integration and availability resolution',
      summary: 'Read real availability from the client\'s calendar system and write confirmed bookings back.',
      acceptanceCriteria: Object.freeze([
        'Availability reflects the live calendar, including existing events and working hours.',
        'A confirmed booking appears on the correct calendar with the agreed metadata.',
        'Double-booking the same slot is impossible under concurrent requests.',
      ]),
      accessTier: 'integration-sandbox',
      weight: 60,
    }),
    Object.freeze({
      slug: 'booking-reminders',
      title: 'Booking confirmations, reminders and reschedule handling',
      summary: 'Confirm, remind and handle reschedule or cancellation without human coordination.',
      acceptanceCriteria: Object.freeze([
        'Confirmation is sent on booking; reminders fire at the agreed intervals.',
        'Reschedule and cancellation update the calendar and the lead record together.',
        'A no-show is recorded and returns the lead to follow-up.',
      ]),
      accessTier: 'staging',
      weight: 40,
    }),
  ]),
  reporting: Object.freeze([
    Object.freeze({
      slug: 'attribution-pipeline',
      title: 'Revenue attribution pipeline',
      summary: 'Join captured leads to appointments and closed revenue so the system\'s contribution is measurable.',
      acceptanceCriteria: Object.freeze([
        'Each closed deal traces back to its originating lead and capture source.',
        'Recovered leads are distinguishable from leads the client would have worked anyway.',
        'Figures reconcile against the client\'s own source of truth within the agreed tolerance.',
      ]),
      accessTier: 'sandbox',
      weight: 50,
    }),
    Object.freeze({
      slug: 'management-dashboard',
      title: 'Management dashboard',
      summary: 'One screen: leads captured, recovered, qualified, booked, closed, and revenue attributable to the system.',
      acceptanceCriteria: Object.freeze([
        'Every headline metric is present and date-filterable.',
        'Each number can be drilled into the underlying records.',
        'The dashboard loads within the agreed performance budget on the client\'s data volume.',
      ]),
      accessTier: 'staging',
      weight: 50,
    }),
  ]),
});

// The launch milestone's tickets are fixed regardless of capability mix.
const LAUNCH_TICKETS = Object.freeze([
  Object.freeze({
    slug: 'end-to-end-hardening',
    title: 'End-to-end hardening and failure-path tests',
    summary: 'Prove the whole path holds under real conditions: retries, outages, malformed input, and duplicate events.',
    acceptanceCriteria: Object.freeze([
      'A full lead-to-booking path passes end to end against staging.',
      'Each external dependency has a tested failure path that does not lose a lead.',
      'No unhandled error path can drop a lead silently.',
    ]),
    accessTier: 'staging',
    weight: 100,
  }),
]);

function round(n, places = 0) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Split a budget across weighted items, rounded to `step` dollars, with the
 * rounding remainder absorbed by the largest item so the parts sum EXACTLY to
 * the budget. A schedule whose milestones sum to $7,975 of an $8,000 budget is
 * an invoice dispute later.
 */
function allocate(budget, items, step = 25) {
  const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
  if (totalWeight <= 0) return items.map(() => 0);
  const raw = items.map((i) => (budget * i.weight) / totalWeight);
  const rounded = raw.map((v) => Math.round(v / step) * step);
  const drift = round(budget - rounded.reduce((a, b) => a + b, 0), 2);
  if (drift !== 0) {
    let largest = 0;
    for (let i = 1; i < rounded.length; i += 1) if (rounded[i] > rounded[largest]) largest = i;
    rounded[largest] = round(rounded[largest] + drift, 2);
  }
  return rounded;
}

function milestoneDefinitions(capabilities) {
  const defs = [
    {
      id: 'discovery-architecture',
      name: 'Discovery, architecture and acceptance criteria',
      ownedBy: 'agency',
      capabilityIds: [],
      deliverables: [
        'Current-state lead-flow map with the measured leak',
        'Target architecture and integration inventory',
        'Written scope document with explicit exclusions',
        'Acceptance test suite for every milestone',
        'Engineering work breakdown, one verifiable item at a time',
      ],
      acceptanceTests: [
        { statement: 'Client has signed the scope document, including the exclusions list.', method: 'countersigned document' },
        { statement: 'Every downstream milestone has at least one objective acceptance test written before any build work starts.', method: 'plan review' },
      ],
    },
  ];

  for (const cap of capabilities) {
    defs.push({
      id: cap.id,
      name: cap.name,
      ownedBy: 'contractor',
      capabilityIds: [cap.id],
      deliverables: [cap.outcome],
      acceptanceTests: [
        { statement: cap.verification, method: 'demonstrated against staging with the client\'s own scenario' },
        { statement: `Automated tests covering ${cap.name} pass in CI on our pipeline.`, method: 'CI run on the merge commit' },
      ],
    });
  }

  defs.push({
    id: 'launch-hardening',
    name: 'Hardening, launch and handover',
    ownedBy: 'shared',
    capabilityIds: capabilities.map((c) => c.id),
    triggersClientBalance: true,
    deliverables: [
      'Production deployment on our infrastructure under our accounts',
      'Runbook and admin documentation',
      'Client team training session',
      'Baseline reporting snapshot for the 90-day review',
    ],
    acceptanceTests: [
      { statement: 'A real inbound lead traverses capture → follow-up → qualification → reporting in production.', method: 'live observed run' },
      { statement: 'The management dashboard reports that lead correctly.', method: 'live observed run' },
      { statement: 'Quality-control checklist passes with zero blocking items open.', method: 'QC gate' },
      { statement: 'Client team has been trained and the runbook handed over.', method: 'session held, document delivered' },
    ],
  });

  return defs;
}

function ticketsFor(milestoneId, budget, clientRef, complianceFlags) {
  const templates = milestoneId === 'launch-hardening' ? LAUNCH_TICKETS : TICKET_TEMPLATES[milestoneId];
  if (!templates) return [];
  const amounts = allocate(budget, templates, 25);
  return templates.map((t, i) => {
    const ticket = {
      id: `${clientRef}-${milestoneId}-${t.slug}`,
      milestoneId,
      title: t.title,
      summary: t.summary,
      acceptanceCriteria: [...t.acceptanceCriteria],
      accessTier: t.accessTier,
      fixedPrice: amounts[i],
      // Stated for planning only. The contractor is paid the fixed price on
      // acceptance, not for the days — this field never becomes a rate.
      billing: 'fixed-price-on-acceptance',
    };
    ticket.accessPlan = accessPlanForTicket(ticket, complianceFlags);
    return ticket;
  });
}

/**
 * Build the full delivery plan.
 *
 * Fail-closed invariants, checked before anything is returned:
 *   - every milestone carries at least one acceptance test
 *   - every contractor milestone carries a non-zero fixed price
 *   - milestone payouts sum exactly to the developer budget
 *   - every ticket has acceptance criteria, a fixed price and an access tier
 * A violation throws. A malformed plan must never reach a contractor.
 */
function buildDeliveryPlan({
  clientRef,
  capabilities: requestedCapabilities = null,
  developerBudget = 0,
  complianceFlags = [],
} = {}) {
  if (!clientRef || typeof clientRef !== 'string') throw new TypeError('clientRef is required to namespace tickets.');
  const budget = Number(developerBudget);
  if (!Number.isFinite(budget) || budget <= 0) throw new TypeError('developerBudget must be a positive number.');

  const capabilities = resolveCapabilities(requestedCapabilities);
  const defs = milestoneDefinitions(capabilities);

  const payable = defs.filter((d) => MILESTONE_WEIGHTS[d.id] > 0);
  const payouts = allocate(budget, payable.map((d) => ({ weight: MILESTONE_WEIGHTS[d.id] })), 25);

  const milestones = defs.map((def) => {
    const payIndex = payable.indexOf(def);
    const developerPayout = payIndex >= 0 ? payouts[payIndex] : 0;
    const milestone = {
      id: def.id,
      name: def.name,
      ownedBy: def.ownedBy,
      capabilityIds: def.capabilityIds,
      deliverables: def.deliverables,
      acceptanceTests: def.acceptanceTests.map((t, i) => ({ id: `${def.id}-at-${i + 1}`, ...t })),
      developerPayout,
      billing: 'fixed-price-on-acceptance',
      triggersClientBalance: def.triggersClientBalance === true,
      tickets: developerPayout > 0 ? ticketsFor(def.id, developerPayout, clientRef, complianceFlags) : [],
    };
    return milestone;
  });

  // ---- invariants ----
  const problems = [];
  for (const m of milestones) {
    if (!m.acceptanceTests.length) problems.push(`Milestone ${m.id} has no acceptance test.`);
    if (m.ownedBy !== 'agency' && m.developerPayout <= 0) problems.push(`Milestone ${m.id} is contractor work with no fixed price.`);
    for (const t of m.tickets) {
      if (!t.acceptanceCriteria.length) problems.push(`Ticket ${t.id} has no acceptance criteria.`);
      if (!(t.fixedPrice > 0)) problems.push(`Ticket ${t.id} has no fixed price.`);
      if (!t.accessTier) problems.push(`Ticket ${t.id} has no access tier.`);
    }
  }
  const allocated = round(milestones.reduce((sum, m) => sum + m.developerPayout, 0), 2);
  if (allocated !== round(budget, 2)) {
    problems.push(`Milestone payouts total $${allocated} but the developer budget is $${round(budget, 2)}.`);
  }
  for (const m of milestones) {
    if (!m.tickets.length) continue;
    const ticketTotal = round(m.tickets.reduce((s, t) => s + t.fixedPrice, 0), 2);
    if (ticketTotal !== round(m.developerPayout, 2)) {
      problems.push(`Milestone ${m.id} ticket prices total $${ticketTotal} but its payout is $${round(m.developerPayout, 2)}.`);
    }
  }
  if (problems.length) throw new Error(`Delivery plan failed validation:\n- ${problems.join('\n- ')}`);

  const tickets = milestones.flatMap((m) => m.tickets);

  return {
    clientRef,
    capabilities: capabilities.map((c) => ({ id: c.id, name: c.name, outcome: c.outcome })),
    milestones,
    tickets,
    developerBudget: round(budget, 2),
    allocatedToMilestones: allocated,
    ticketCount: tickets.length,
    acceptanceTestCount: milestones.reduce((n, m) => n + m.acceptanceTests.length, 0),
  };
}

module.exports = {
  MILESTONE_WEIGHTS,
  TICKET_TEMPLATES,
  LAUNCH_TICKETS,
  allocate,
  buildDeliveryPlan,
};

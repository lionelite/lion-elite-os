'use strict';

// THE authoritative agent registry (Issue #73).
//
// Before this file there were two descriptions of the same six agents and
// nothing reconciled them: `ai-agents/*.md` (design docs read by no code) and
// six inline `systemPrompt` strings in `server.js`. CLAUDE.md flags the drift
// explicitly. This is the single source of truth — `server.js` reads it, the
// docs point at it, and a test fails if an agent's declared actions are not
// actually dispatchable.
//
// What makes these agents rather than prompts: each role carries
//   - a MANDATE (the decision it owns),
//   - KPIs it moves (so "did it work" is answerable),
//   - KNOWLEDGE DOMAINS: the repo paths that are that role's evidence base, so
//     an agent reasons over the owner's real data rather than generic priors,
//   - ACTIONS it may request, every one drawn from the dispatcher's allowlist,
//   - and for anything outward-facing, the CONTROL that gates it.
//
// EXECUTION POSTURE. Agents do not send, publish, or spend. They request
// allowlisted queue jobs through `lib/openai-action-dispatcher.js` (whose
// vocabulary lives in `lib/action-catalog.js`), which
// fail-closed on anything else. Where a role's useful next step would cross a
// gate that is off, the agent records `blocked by <CONTROL>` and moves on — it
// never works around it, and it never flips a switch. That mirrors the
// video-learning module's posture and the hard limits in CLAUDE.md.

const { ALLOWED_QUEUE_ACTIONS, BLOCKED_ACTIONS } = require('../action-catalog');

// Issue #73's operating target. Env-overridable; these are the documented
// defaults so the loop works with zero configuration.
const DAILY_REVENUE_TARGET = Number(process.env.DAILY_REVENUE_TARGET || 3500);
const DAILY_REVENUE_STRETCH = Number(process.env.DAILY_REVENUE_STRETCH || 5000);

// The controls that gate outward-facing work. Named, not inlined, so an agent's
// blocked step says which switch a human would have to flip — and so this list
// is greppable against the real env vars.
const CONTROLS = Object.freeze({
  OUTREACH_SEND_ENABLED: 'Governed B2B/B2C e-mail sending (lib/email-delivery.js).',
  SMS_SEND_ENABLED: 'Consent-gated SMS (lib/sms/*). TCPA consent is not owner-waivable.',
  SOCIAL_PUBLISH_ENABLED: 'Own-brand social publishing (lib/social/publishers/*).',
  BLUESKY_OUTREACH_ENABLED: 'Replies to posts that @-mention us, and nothing else.',
  AD_SPEND_CAP: 'Owner-approved paid-media cap. No cap established means no spend.',
  HUMAN_APPROVAL: 'A person decides. The agent prepares and stops.',
});

// Intraday checkpoints from #73. Each names what it must establish, so a
// checkpoint that produces no decision is a visible failure rather than a
// status paragraph.
const CHECKPOINTS = Object.freeze([
  Object.freeze({
    id: 'morning',
    establishes: 'Today\'s collected-revenue target, the current gap, and the opening assignment set.',
    action: 'morning-brief',
  }),
  Object.freeze({
    id: 'midday',
    establishes: 'Contacted leads, replies, qualified opportunities, checkouts, collected revenue, content publication status.',
    action: 'midday-revenue-check',
  }),
  Object.freeze({
    id: 'afternoon',
    establishes: 'Whether we are behind pace, and if so which highest-intent eligible work gets the remaining effort.',
    action: 'business-health-snapshot',
  }),
  Object.freeze({
    id: 'evening',
    establishes: 'Collected revenue, pipeline created, conversion by source, failures, tomorrow\'s carryover.',
    action: 'evening-review',
  }),
]);

const ROLES = Object.freeze([
  Object.freeze({
    id: 'executive',
    title: 'Executive Agent',
    mandate: 'Own the daily revenue number. Compute the gap, assign work by expected revenue impact, reallocate when behind pace, and surface exceptions instead of status.',
    // What it is NOT allowed to do is part of the role: an executive agent that
    // can send is an executive agent that will.
    ownsDecision: 'Which agent works on what, in what order, today.',
    kpis: Object.freeze(['collected_revenue_today', 'gap_to_target', 'pipeline_created', 'assignments_completed']),
    knowledgeDomains: Object.freeze([
      'docs/LION-ELITE-REVENUE-OPERATING-SYSTEM.md',
      'docs/revenue-engine.md',
      'docs/LION_ELITE_OPERATING_CONTEXT.md',
      'revenue-intelligence',
      'CLAUDE.md',
    ]),
    actions: Object.freeze(['morning-brief', 'midday-revenue-check', 'evening-review', 'business-health-snapshot']),
    gates: Object.freeze([]),
    reportsTo: null,
  }),
  Object.freeze({
    id: 'sales',
    title: 'Sales Agent',
    mandate: 'Convert eligible warm leads and existing customers. Rank by intent, recency, relationship and expected value; progress contacted → replied → qualified → checkout → paid; stop the moment a contact opts out or becomes ineligible.',
    ownsDecision: 'Which specific leads get worked next, and in what order.',
    kpis: Object.freeze(['leads_contacted', 'replies', 'qualified', 'checkouts', 'collected_revenue']),
    knowledgeDomains: Object.freeze([
      'sales/master-sales-framework.md', // Issue #41 calls this docs/core-sales-framework.md, which has never existed in the repo
      'sales',
      'ai-agents/sales-agent.md',
      'docs/prospect-pipeline.md',
      'docs/outreach-campaigns.md',
      'docs/lead-activation.md',
    ]),
    actions: Object.freeze(['discover-prospects', 'research-prospect', 'enrich-prospect', 'qualify-prospect', 'draft-outreach', 'validate-outreach']),
    // Drafting and validating are ours. The send is not.
    gates: Object.freeze(['OUTREACH_SEND_ENABLED', 'SMS_SEND_ENABLED']),
    reportsTo: 'executive',
  }),
  Object.freeze({
    id: 'marketing',
    title: 'Marketing Agent',
    mandate: 'Produce brand-correct, compliance-passing creative for all three brands, verify what actually published, and feed measured results back into the next round.',
    ownsDecision: 'What creative gets made and which pieces are good enough to go out.',
    kpis: Object.freeze(['content_generated', 'content_published', 'engagement', 'leads_attributed']),
    knowledgeDomains: Object.freeze([
      'marketing-intelligence',
      'knowledge/marketing',
      'ai-agents/marketing-agent.md',
      'docs/social-content-pipeline.md',
      'docs/social-creative-standard.md',
      'docs/ad-launch-playbook.md',
    ]),
    actions: Object.freeze(['generate-social-content']),
    gates: Object.freeze(['SOCIAL_PUBLISH_ENABLED', 'AD_SPEND_CAP']),
    reportsTo: 'executive',
  }),
  Object.freeze({
    id: 'client-success',
    title: 'Client Success Agent',
    mandate: 'Retain and reactivate existing customers. Route coaching interest to Lion Elite Beauty without ever attaching human-use language to Lion Elite Wellness product.',
    ownsDecision: 'Which existing customers are due contact, and through which brand.',
    kpis: Object.freeze(['reactivations', 'retention_rate', 'coaching_applications', 'repeat_purchase']),
    knowledgeDomains: Object.freeze([
      'docs/coaching-pwa.md',
      'docs/coaching-multi-coach.md',
      'docs/customer-communication-rules.md',
      'docs/sms-campaigns.md',
      'business-scaling/founder-intelligence',
    ]),
    actions: Object.freeze(['qualify-prospect', 'draft-outreach', 'validate-outreach']),
    gates: Object.freeze(['OUTREACH_SEND_ENABLED', 'SMS_SEND_ENABLED']),
    reportsTo: 'executive',
  }),
  Object.freeze({
    id: 'operations',
    title: 'Operations Agent',
    mandate: 'Keep paid orders moving through fulfilment, tracking and customer notification. Surface payment and fulfilment exceptions immediately rather than at end of day.',
    ownsDecision: 'Which operational exception is escalated now.',
    kpis: Object.freeze(['orders_fulfilled', 'fulfilment_exceptions', 'time_to_ship', 'failed_jobs']),
    knowledgeDomains: Object.freeze([
      'operations',
      'ai-agents/operations-agent.md',
      'docs/order-notification.md',
      'docs/render-observability.md',
      'docs/automation-healthcheck.md',
    ]),
    actions: Object.freeze(['business-health-snapshot', 'create-github-issue']),
    gates: Object.freeze([]),
    reportsTo: 'executive',
  }),
  Object.freeze({
    id: 'finance-kpi',
    title: 'Finance & KPI Agent',
    mandate: 'Reconcile collected revenue, attribute it to source/campaign/rep where the data supports it, and keep the pace against target honest — including saying when attribution is not possible.',
    ownsDecision: 'What the revenue number actually is, and how much of it is attributable.',
    kpis: Object.freeze(['collected_revenue', 'attributed_revenue', 'pace_to_target', 'average_order_value']),
    knowledgeDomains: Object.freeze([
      'finance-intelligence',
      'ai-agents/finance-kpi-agent.md',
      'docs/revenue-opportunity-scanner.md',
      'revenue-intelligence',
    ]),
    actions: Object.freeze(['midday-revenue-check', 'business-health-snapshot']),
    gates: Object.freeze([]),
    reportsTo: 'executive',
  }),
  Object.freeze({
    id: 'research-compliance',
    title: 'Research Compliance Agent',
    mandate: 'Hold the Research-Use-Only line on everything customer-facing. Rewrite risky copy into research-safe language and keep internal inventory detail out of customer communication.',
    // This role has a veto rather than a revenue KPI. Giving it a revenue
    // target would put it in conflict with the thing it exists to enforce.
    ownsDecision: 'Whether a piece of customer-facing copy may leave the building.',
    kpis: Object.freeze(['copy_reviewed', 'blocks_issued', 'compliance_regressions']),
    knowledgeDomains: Object.freeze([
      'ai-agents/research-compliance-agent.md',
      'docs/customer-communication-rules.md',
      'docs/social-creative-standard.md',
      'docs/outreach-campaigns.md',
    ]),
    actions: Object.freeze(['validate-outreach']),
    gates: Object.freeze([]),
    hasVeto: true,
    reportsTo: 'executive',
  }),
]);

function role(id) {
  return ROLES.find((r) => r.id === id) || null;
}

function roleIds() {
  return ROLES.map((r) => r.id);
}

/**
 * Validate the registry against the dispatcher it depends on.
 *
 * This is the anti-drift check that `ai-agents/*.md` never had: if someone gives
 * an agent an action the dispatcher cannot route, or one on the blocked list,
 * this fails loudly instead of the agent silently requesting something that is
 * refused at run time.
 */
function validateRegistry() {
  const problems = [];
  const seen = new Set();

  for (const r of ROLES) {
    if (seen.has(r.id)) problems.push(`Duplicate role id "${r.id}".`);
    seen.add(r.id);
    if (!r.mandate || r.mandate.length < 20) problems.push(`Role ${r.id} has no usable mandate.`);
    if (!r.ownsDecision) problems.push(`Role ${r.id} owns no decision — then it is a report, not an agent.`);
    if (!r.kpis.length) problems.push(`Role ${r.id} has no KPI, so "did it work" is unanswerable.`);
    if (!r.knowledgeDomains.length) problems.push(`Role ${r.id} has no knowledge domain to learn from.`);

    for (const action of r.actions) {
      if (BLOCKED_ACTIONS.has(action)) {
        problems.push(`Role ${r.id} declares blocked action "${action}".`);
      } else if (!ALLOWED_QUEUE_ACTIONS[action]) {
        problems.push(`Role ${r.id} declares "${action}", which is not in the dispatcher allowlist.`);
      }
    }
    for (const gate of r.gates) {
      if (!CONTROLS[gate]) problems.push(`Role ${r.id} references unknown control "${gate}".`);
    }
    if (r.reportsTo && !ROLES.some((x) => x.id === r.reportsTo)) {
      problems.push(`Role ${r.id} reports to unknown role "${r.reportsTo}".`);
    }
  }

  if (!ROLES.some((r) => r.reportsTo === null)) problems.push('No coordinating role — somebody has to own the number.');
  return { valid: problems.length === 0, problems };
}

module.exports = {
  DAILY_REVENUE_TARGET,
  DAILY_REVENUE_STRETCH,
  CONTROLS,
  CHECKPOINTS,
  ROLES,
  role,
  roleIds,
  validateRegistry,
};

'use strict';

// The action vocabulary, extracted as a pure module with no dependencies.
//
// This lived inside `openai-action-dispatcher.js`, which requires `job-queues`
// and therefore `bullmq` and a Redis connection. Anything wanting to *reason
// about* what actions exist — the agent registry, its tests, a validator — had
// to drag a live queue client in to read two frozen objects.
//
// Same extraction, and same reason, as `lib/integration-normalization.js`: keep
// the decidable part pure so it is unit-testable without infrastructure. The
// dispatcher re-exports both constants, so existing consumers are unaffected.

// Queue jobs an agent may request. Anything not here is refused.
const ALLOWED_QUEUE_ACTIONS = Object.freeze({
  'morning-brief': { queue: 'analytics', job: 'morning-brief' },
  'midday-revenue-check': { queue: 'analytics', job: 'midday-revenue-check' },
  'evening-review': { queue: 'analytics', job: 'evening-review' },
  'business-health-snapshot': { queue: 'analytics', job: 'business-health-snapshot' },
  'generate-social-content': { queue: 'executive', job: 'generate-social-content' },
  'discover-prospects': { queue: 'discovery', job: 'discover-prospects' },
  'research-prospect': { queue: 'research', job: 'research-prospect' },
  'enrich-prospect': { queue: 'enrichment', job: 'enrich-prospect' },
  'qualify-prospect': { queue: 'qualification', job: 'qualify-prospect' },
  'draft-outreach': { queue: 'email', job: 'draft-outreach' },
  'validate-outreach': { queue: 'validation', job: 'validate-outreach' },
  'create-github-issue': { queue: 'integrations', job: 'create-github-issue' }
});

// Never dispatchable, whatever asks. Note what is on this list: every outward
// -facing or irreversible act. An agent that wants one of these has to hand it
// to a human, which is the point.
const BLOCKED_ACTIONS = new Set([
  'send-email',
  'publish-content',
  'deploy-production',
  'charge-payment',
  'issue-refund',
  'delete-record',
  'medical-recommendation',
  'legal-decision'
]);

// Queue keys that a worker in `workers/` actually consumes.
//
// This matters because `dispatchAction()` returns `status: 'queued'` whether or
// not anything will ever pick the job up. Four allowlisted actions target queues
// with no consumer — `generate-social-content` (executive), `research-prospect`
// (research), `enrich-prospect` (enrichment) and `qualify-prospect`
// (qualification) — so dispatching them looks like success and produces nothing.
// That is a pre-existing architecture gap, not a config error: either the
// workers need writing or those actions should leave the allowlist. Until it is
// resolved, callers can at least tell the difference, which is what this set is
// for.
//
// Kept here rather than detected at run time because detecting it would mean
// booting the workers. `test/action-catalog.test.js` greps `workers/*.js` and
// fails if this list drifts from the workers that actually exist.
const CONSUMED_QUEUES = Object.freeze(new Set([
  'discovery',    // workers/discovery-worker.js
  'analytics',    // workers/executive-worker.js
  'integrations', // workers/integration-worker.js
  'email',        // workers/outreach-worker.js
  'validation',   // workers/outreach-worker.js
  'dispatch',     // workers/outreach-worker.js
]));

/** Would this action's job actually be processed by anything? */
function hasConsumer(action) {
  const target = ALLOWED_QUEUE_ACTIONS[action];
  return Boolean(target) && CONSUMED_QUEUES.has(target.queue);
}

/** Allowlisted actions whose queue has no worker. Dispatching these is a no-op. */
function orphanedActions() {
  return Object.keys(ALLOWED_QUEUE_ACTIONS).filter((a) => !hasConsumer(a));
}

module.exports = { ALLOWED_QUEUE_ACTIONS, BLOCKED_ACTIONS, CONSUMED_QUEUES, hasConsumer, orphanedActions };

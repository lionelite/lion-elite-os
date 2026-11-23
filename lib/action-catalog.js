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
  // Action name and job name are deliberately different here. The agent-facing
  // verb stays `discover-prospects`, but discovery-worker.js accepts only the job
  // name `scheduled-business-discovery` and throws UNSUPPORTED_DISCOVERY_JOB on
  // anything else — so dispatching this used to reach the right queue and then
  // fail at the worker, landing in the dead-letter queue. Separating the two
  // fields is exactly what this structure is for.
  'discover-prospects': { queue: 'discovery', job: 'scheduled-business-discovery' },
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

// Whether an allowlisted action's job would actually be handled.
//
// `dispatchAction()` returns `status: 'queued'` whether or not anything consumes
// the queue — and whether or not the consuming worker accepts that job NAME. Both
// have bitten this repo: four actions target queues with no worker, and
// `discover-prospects` used to carry a job name discovery-worker rejects.
//
// Consumption is declared in `lib/queue-manifest.js` (dependency-free) rather
// than inferred here, because a regex over the worker files missed
// outreach-worker.js entirely — it subscribes through a helper. See that file for
// the history.
const { jobDeliverability, KNOWN_ORPHAN_QUEUES } = require('./queue-manifest');

/** Would this action's job actually be processed by a worker? */
function hasConsumer(action) {
  const target = ALLOWED_QUEUE_ACTIONS[action];
  if (!target) return false;
  return jobDeliverability(target.queue, target.job).deliverable;
}

/** Why not, when it would not be. Null when it would. */
function deliveryGap(action) {
  const target = ALLOWED_QUEUE_ACTIONS[action];
  if (!target) return { reason: 'unknown-action', detail: `"${action}" is not allowlisted.` };
  const result = jobDeliverability(target.queue, target.job);
  return result.deliverable ? null : { reason: result.reason, detail: result.detail };
}

/** Allowlisted actions whose job would not be handled. Dispatching these is a no-op. */
function orphanedActions() {
  return Object.keys(ALLOWED_QUEUE_ACTIONS).filter((a) => !hasConsumer(a));
}

module.exports = { ALLOWED_QUEUE_ACTIONS, BLOCKED_ACTIONS, KNOWN_ORPHAN_QUEUES, hasConsumer, deliveryGap, orphanedActions };

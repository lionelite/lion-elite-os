'use strict';

const crypto = require('crypto');
const { addJob } = require('./job-queues');

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

function actionName(action) {
  return String(action?.payload?.action || action?.id || '').trim();
}

function canExecute(action, approvalMode) {
  const name = actionName(action);
  if (BLOCKED_ACTIONS.has(name)) return { allowed: false, reason: 'BLOCKED_SENSITIVE_ACTION' };
  if (action.type === 'external-action') return { allowed: false, reason: 'EXTERNAL_ACTION_REQUIRES_DEDICATED_INTEGRATION' };
  if (!ALLOWED_QUEUE_ACTIONS[name]) return { allowed: false, reason: 'ACTION_NOT_ALLOWLISTED' };
  if (approvalMode !== 'automatic' && action.requiresApproval !== false) {
    return { allowed: false, reason: 'HUMAN_APPROVAL_REQUIRED' };
  }
  return { allowed: true, reason: 'ALLOWLISTED' };
}

async function dispatchAction(action, context = {}) {
  const decision = canExecute(action, context.approvalMode);
  const name = actionName(action);
  if (!decision.allowed) {
    return { actionId: action.id, action: name, status: 'not-executed', reason: decision.reason };
  }

  const target = ALLOWED_QUEUE_ACTIONS[name];
  const executionId = crypto.randomUUID();
  const payload = {
    ...action.payload,
    executionId,
    actionId: action.id,
    requestedBy: context.requestedBy,
    requestedAt: new Date().toISOString(),
    source: 'openai-executive-agent'
  };
  delete payload.action;

  const job = await addJob(target.queue, target.job, payload, {
    jobId: `ai:${name}:${executionId}`,
    removeOnComplete: 250,
    removeOnFail: 500
  });

  return {
    actionId: action.id,
    action: name,
    status: 'queued',
    executionId,
    queue: target.queue,
    job: target.job,
    jobId: job.id
  };
}

async function dispatchPlan(agentResult) {
  const executions = [];
  for (const action of agentResult.plan.actions) {
    executions.push(await dispatchAction(action, agentResult));
  }
  return {
    ...agentResult,
    live: true,
    executedAt: new Date().toISOString(),
    executions
  };
}

module.exports = { ALLOWED_QUEUE_ACTIONS, BLOCKED_ACTIONS, actionName, canExecute, dispatchAction, dispatchPlan };

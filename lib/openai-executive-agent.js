'use strict';

const DEFAULT_MODEL = process.env.OPENAI_EXECUTIVE_MODEL || 'gpt-5.4';
const MAX_COMMAND_LENGTH = 12000;

function normalizeCommand(input = {}) {
  const command = String(input.command || '').trim();
  if (!command) {
    const error = new Error('COMMAND_REQUIRED');
    error.code = 'COMMAND_REQUIRED';
    throw error;
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    const error = new Error('COMMAND_TOO_LARGE');
    error.code = 'COMMAND_TOO_LARGE';
    throw error;
  }

  return {
    command,
    brands: Array.isArray(input.brands) && input.brands.length
      ? input.brands.map(String).slice(0, 10)
      : ['lion-elite-wellness', 'lion-elite-beauty'],
    objective: String(input.objective || 'Execute the highest-value safe action sequence').slice(0, 500),
    constraints: Array.isArray(input.constraints)
      ? input.constraints.map(String).slice(0, 20)
      : [],
    approvalMode: input.approvalMode === 'human-required' ? 'human-required' : 'automatic',
    requestedBy: String(input.requestedBy || 'lion-os-user').slice(0, 200)
  };
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('EMPTY_AGENT_RESPONSE');
  try { return JSON.parse(raw); } catch (_error) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('INVALID_AGENT_JSON');
  }
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('INVALID_PLAN');
  if (!Array.isArray(plan.actions)) throw new Error('PLAN_ACTIONS_REQUIRED');
  return {
    summary: String(plan.summary || '').slice(0, 2000),
    priority: ['critical', 'high', 'medium', 'low'].includes(plan.priority) ? plan.priority : 'medium',
    actions: plan.actions.slice(0, 20).map((action, index) => ({
      id: String(action.id || `action-${index + 1}`).slice(0, 100),
      title: String(action.title || 'Untitled action').slice(0, 300),
      owner: String(action.owner || 'lion-os').slice(0, 100),
      system: String(action.system || 'lion-os').slice(0, 100),
      type: ['analysis', 'draft', 'github-issue', 'queue-job', 'external-action'].includes(action.type) ? action.type : 'analysis',
      requiresApproval: action.requiresApproval === true,
      rationale: String(action.rationale || '').slice(0, 1000),
      payload: action.payload && typeof action.payload === 'object' ? action.payload : {}
    })),
    risks: Array.isArray(plan.risks) ? plan.risks.map(String).slice(0, 10) : [],
    successMetrics: Array.isArray(plan.successMetrics) ? plan.successMetrics.map(String).slice(0, 10) : [],
    nextDecision: String(plan.nextDecision || '').slice(0, 1000)
  };
}

async function runExecutiveAgent(input) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY_MISSING');
    error.code = 'OPENAI_API_KEY_MISSING';
    throw error;
  }

  const context = normalizeCommand(input);
  const { Agent, run } = await import('@openai/agents');
  const agent = new Agent({
    name: 'LionOS Executive Agent',
    model: DEFAULT_MODEL,
    instructions: [
      'You are the live executive orchestration layer for LionOS.',
      'Convert the operator command into actions that LionOS can execute immediately.',
      'Use allowlisted queue actions whenever they can advance the objective.',
      'Never claim completion unless an execution result proves it.',
      'Sensitive actions such as sending, publishing, production deployment, payments, deletion, medical decisions, or legal decisions must remain blocked or require a dedicated approved integration.',
      'Lion Elite Wellness public content must remain research-education only and must not provide dosing, treatment, diagnosis, or human-use instructions.',
      'Allowed payload.action values are: morning-brief, midday-revenue-check, evening-review, business-health-snapshot, generate-social-content, discover-prospects, research-prospect, enrich-prospect, qualify-prospect, draft-outreach, validate-outreach, create-github-issue.',
      'Return JSON only with keys: summary, priority, actions, risks, successMetrics, nextDecision.',
      'Each executable action must use type queue-job or github-issue and include payload.action from the allowlist.',
      'Set requiresApproval false for safe allowlisted work and true only when a human decision is genuinely needed.'
    ].join('\n')
  });

  const prompt = JSON.stringify({
    operatorContext: context,
    operatingRule: 'Execute safe allowlisted actions now. Do not stop at planning.',
    expectedOutput: 'Strict JSON object only.'
  });

  const result = await run(agent, prompt, { maxTurns: 6 });
  return {
    model: DEFAULT_MODEL,
    generatedAt: new Date().toISOString(),
    approvalMode: context.approvalMode,
    requestedBy: context.requestedBy,
    plan: validatePlan(extractJson(result.finalOutput))
  };
}

module.exports = { DEFAULT_MODEL, MAX_COMMAND_LENGTH, normalizeCommand, extractJson, validatePlan, runExecutiveAgent };

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
    objective: String(input.objective || 'Create the highest-value executable plan').slice(0, 500),
    constraints: Array.isArray(input.constraints)
      ? input.constraints.map(String).slice(0, 20)
      : [],
    approvalMode: input.approvalMode === 'automatic' ? 'automatic' : 'human-required',
    requestedBy: String(input.requestedBy || 'lion-os-user').slice(0, 200)
  };
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('EMPTY_AGENT_RESPONSE');

  try {
    return JSON.parse(raw);
  } catch (_error) {
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
    priority: ['critical', 'high', 'medium', 'low'].includes(plan.priority)
      ? plan.priority
      : 'medium',
    actions: plan.actions.slice(0, 20).map((action, index) => ({
      id: String(action.id || `action-${index + 1}`).slice(0, 100),
      title: String(action.title || 'Untitled action').slice(0, 300),
      owner: String(action.owner || 'human').slice(0, 100),
      system: String(action.system || 'lion-os').slice(0, 100),
      type: ['analysis', 'draft', 'github-issue', 'queue-job', 'external-action'].includes(action.type)
        ? action.type
        : 'analysis',
      requiresApproval: action.requiresApproval !== false,
      rationale: String(action.rationale || '').slice(0, 1000),
      payload: action.payload && typeof action.payload === 'object' ? action.payload : {}
    })),
    risks: Array.isArray(plan.risks) ? plan.risks.map(String).slice(0, 10) : [],
    successMetrics: Array.isArray(plan.successMetrics)
      ? plan.successMetrics.map(String).slice(0, 10)
      : [],
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
      'You are the executive orchestration layer for LionOS.',
      'Convert the operator command into a concise, executable business plan.',
      'Never claim an external action was completed unless a tool result proves it.',
      'Default all customer communication, financial actions, publishing, deployments, data mutations, and medical or legal decisions to human approval.',
      'Lion Elite Wellness public content must remain research-education only and must not provide dosing, treatment, diagnosis, or human-use instructions.',
      'Prefer existing LionOS systems: executive queues, outreach validation, CRM records, GitHub issues, content workflows, and real-estate intelligence.',
      'Return JSON only with keys: summary, priority, actions, risks, successMetrics, nextDecision.',
      'Each action must have: id, title, owner, system, type, requiresApproval, rationale, payload.',
      'Allowed action types: analysis, draft, github-issue, queue-job, external-action.'
    ].join('\n')
  });

  const prompt = JSON.stringify({
    operatorContext: context,
    operatingRule: 'Plan first. Side effects require explicit downstream authorization.',
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

module.exports = {
  DEFAULT_MODEL,
  MAX_COMMAND_LENGTH,
  normalizeCommand,
  extractJson,
  validatePlan,
  runExecutiveAgent
};

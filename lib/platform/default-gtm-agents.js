'use strict';

const DEFAULT_GTM_AGENTS = Object.freeze([
  { key:'leads', name:'Leads Agent', role:'Source and enrich reachable prospects that match the workspace ICP.' },
  { key:'intent', name:'Intent Agent', role:'Watch evidence and score when a prospect is warm enough to enter a campaign.' },
  { key:'outbound', name:'Outbound Agent', role:'Sequence eligible prospects through approved channels and stop immediately on reply.' },
  { key:'copy', name:'Copy Agent', role:'Write messages only from known profile data and observed evidence.' },
  { key:'qa', name:'QA Agent', role:'Block invented claims, policy violations, missing evidence, and unsafe sends before delivery.' }
]);

function provisionDefaultAgents(workspaceId) {
  if (!workspaceId) throw new Error('workspaceId is required');
  return DEFAULT_GTM_AGENTS.map(agent => ({
    workspaceId,
    agentKey: agent.key,
    name: agent.name,
    role: agent.role,
    status: 'active',
    config: { schedule: 'every_minute', default: true }
  }));
}

module.exports={DEFAULT_GTM_AGENTS,provisionDefaultAgents};

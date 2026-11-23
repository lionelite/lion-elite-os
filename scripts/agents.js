#!/usr/bin/env node
'use strict';

// CLI over the agent roster (Issue #73).
//
//   node scripts/agents.js roster                       # the authoritative registry
//   node scripts/agents.js knowledge [roleId]           # what each agent has learned
//   node scripts/agents.js recall <roleId> "<query>"    # cited facts from its own corpus
//   node scripts/agents.js plan [--collected N] [--hour H] [--checkpoint id]
//   node scripts/agents.js day [--collected N]
//
// Read-only. It prints plans; dispatching them is the executive orchestrator's
// job, through the existing allowlisted dispatcher.

const roles = require('../lib/agents/roles');
const knowledge = require('../lib/agents/knowledge');
const coordinator = require('../lib/agents/coordinator');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function money(n) {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US')}`;
}

function roster() {
  const validation = roles.validateRegistry();
  console.log(`Lion Elite agent roster — ${roles.ROLES.length} roles, registry ${validation.valid ? 'valid' : 'INVALID'}`);
  if (!validation.valid) for (const p of validation.problems) console.log(`  ✗ ${p}`);
  console.log(`Daily target ${money(roles.DAILY_REVENUE_TARGET)}, stretch ${money(roles.DAILY_REVENUE_STRETCH)}`);
  console.log('');
  for (const r of roles.ROLES) {
    console.log(`${r.title}${r.hasVeto ? '  [has veto]' : ''}`);
    console.log(`  owns      ${r.ownsDecision}`);
    console.log(`  mandate   ${r.mandate}`);
    console.log(`  kpis      ${r.kpis.join(', ')}`);
    console.log(`  actions   ${r.actions.join(', ') || '—'}`);
    if (r.gates.length) console.log(`  gated by  ${r.gates.join(', ')}`);
    console.log('');
  }
}

function knowledgeReport(roleId) {
  if (roleId) {
    const k = knowledge.buildKnowledge(roleId);
    console.log(`${k.title} — ${k.factCount} facts from ${k.sources.length} source(s)`);
    console.log(`grounded: ${k.grounded}`);
    console.log(`by kind:  ${Object.entries(k.byKind).map(([a, b]) => `${a}=${b}`).join(', ')}`);
    if (k.missingDomains.length) console.log(`MISSING:  ${k.missingDomains.join(', ')}`);
    if (k.internalOnlySources.length) {
      console.log('');
      console.log('internal-only sources (carry human-use/dosing language — adopt the rule, never the wording):');
      for (const f of k.internalOnlySources) console.log(`  ${f}`);
    }
    console.log('');
    console.log('sources:');
    for (const s of k.sources) console.log(`  ${String(s.facts.length).padStart(4)} facts  ${s.file}${s.internalOnly ? '  [internal-only]' : ''}`);
    return;
  }
  const report = knowledge.coverageReport();
  console.log(`Agent knowledge coverage — ${report.totalFacts} facts indexed from the repo`);
  console.log('');
  for (const r of report.roles) {
    console.log(`  ${r.roleId.padEnd(20)} ${String(r.sources).padStart(3)} sources ${String(r.facts).padStart(5)} facts  ${r.grounded ? 'grounded' : 'UNGROUNDED'}${r.internalOnlySources ? `  ${r.internalOnlySources} internal-only` : ''}`);
  }
  if (report.ungrounded.length) {
    console.log('');
    console.log(`UNGROUNDED ROLES: ${report.ungrounded.join(', ')} — these agents have no evidence base.`);
  }
  if (report.brokenDomains.length) {
    console.log('');
    console.log('BROKEN KNOWLEDGE DOMAINS (a role points at data that is not there):');
    for (const b of report.brokenDomains) console.log(`  ${b.roleId} -> ${b.domain}`);
  }
}

function recall() {
  const roleId = process.argv[3];
  const query = process.argv.slice(4).join(' ');
  if (!roleId || !query) {
    console.error('Usage: node scripts/agents.js recall <roleId> "<query>"');
    process.exitCode = 1;
    return;
  }
  const k = knowledge.buildKnowledge(roleId);
  const hits = knowledge.recall(k, query);
  if (!hits.length) {
    console.log(`${k.title} has nothing on "${query}" in its ${k.factCount} indexed facts. That is an answer: do not improvise one.`);
    return;
  }
  console.log(`${k.title} on "${query}":`);
  console.log('');
  for (const h of hits) console.log(`  ${h.text}\n      ${h.file}:${h.line}  (${h.kind})`);
}

function plan() {
  const collected = Number(arg('collected', 0));
  const hour = arg('hour') === undefined ? undefined : Number(arg('hour'));
  const checkpoint = arg('checkpoint');

  const render = (p) => {
    console.log(p.summary);
    if (p.gatesClosed.length) {
      console.log(`gates closed: ${p.gatesClosed.join(', ')} — drafting proceeds, nothing leaves.`);
    }
    for (const a of p.assignments) {
      const blocked = a.blockedFollowThrough.length ? `  [blocked: ${a.blockedFollowThrough.map((g) => g.control).join(', ')}]` : '';
      console.log(`  ${String(a.impact)}  ${a.roleId.padEnd(20)}${a.action.padEnd(26)}${blocked}`);
    }
    console.log('');
  };

  if (checkpoint) {
    render(coordinator.planCheckpoint(checkpoint, { collectedToday: collected, hour }));
    return;
  }
  for (const p of coordinator.planDay({ collectedByCheckpoint: { morning: collected, midday: collected, afternoon: collected, evening: collected } })) {
    render(p);
  }
}

function main() {
  const command = process.argv[2];
  switch (command) {
    case 'roster': return roster();
    case 'knowledge': return knowledgeReport(process.argv[3]);
    case 'recall': return recall();
    case 'plan':
    case 'day': return plan();
    default:
      console.log('Usage: node scripts/agents.js <roster|knowledge|recall|plan>');
      console.log('  roster                            the authoritative agent registry');
      console.log('  knowledge [roleId]                what each agent has learned, and from where');
      console.log('  recall <roleId> "<query>"         cited facts from that agent\'s corpus');
      console.log('  plan [--collected N] [--hour H] [--checkpoint morning|midday|afternoon|evening]');
      process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Refused: ${error.message}`);
    process.exitCode = 1;
  }
}

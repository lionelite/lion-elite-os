#!/usr/bin/env node
'use strict';

// Runs one agent checkpoint for real (Issue #73).
//
//   node scripts/run-agent-checkpoint.js morning
//   node scripts/run-agent-checkpoint.js midday --collected 1800
//   node scripts/run-agent-checkpoint.js afternoon --dry-run
//
// This is the edge where the pure modules meet real infrastructure. It builds
// the plan (`coordinator.js`), dispatches it through the existing allowlisted
// dispatcher (`openai-action-dispatcher.js`), and records outcomes.
//
// APPROVAL MODE. The dispatcher requires a person to approve each action unless
// it is told the mode is `automatic`. That default is a control, so this script
// does not override it: pass `--auto` or set `AGENT_APPROVAL_MODE=automatic`,
// which is an explicit operator decision, and the run says which mode it used.
// Without it the run reports how many assignments are waiting on a human and
// dispatches nothing — which is a correct outcome, not a failure.
//
// It dispatches read-only analytics and draft/qualify jobs. It sends nothing:
// every outward-facing step stays behind the controls in CLAUDE.md, and the run
// report names any that are closed.

const fs = require('node:fs');
const path = require('node:path');

const coordinator = require('../lib/agents/coordinator');
const runner = require('../lib/agents/runner');

const CHECKPOINT_HOURS = { morning: 9, midday: 13, afternoon: 16, evening: 19 };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

/**
 * Persist the run so outcomes survive the process. Redis is the repo's pattern
 * for executive reports; without it we fall back to a local file and SAY so,
 * rather than silently discarding the record.
 */
async function persist(run) {
  const key = `agents:run:${run.checkpoint}:${new Date().toISOString().slice(0, 10)}`;
  try {
    const { getRedis, ensureConnected, closeRedis } = require('../lib/redis');
    await ensureConnected();
    await getRedis().set(key, JSON.stringify(run), 'EX', 60 * 60 * 24 * 30);
    await closeRedis();
    return { stored: 'redis', key };
  } catch (error) {
    const dir = path.join(__dirname, '..', 'agent-outputs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `agent-run-${run.checkpoint}-${new Date().toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
      return { stored: 'local-file', key: path.relative(path.join(__dirname, '..'), file), redisError: error.message };
    } catch (writeError) {
      return { stored: 'nowhere', redisError: error.message, writeError: writeError.message };
    }
  }
}

async function main() {
  const checkpoint = process.argv[2];
  if (!checkpoint || !CHECKPOINT_HOURS[checkpoint]) {
    console.error(`Usage: node scripts/run-agent-checkpoint.js <${Object.keys(CHECKPOINT_HOURS).join('|')}> [--collected N] [--auto] [--dry-run]`);
    process.exitCode = 1;
    return;
  }

  const collected = Number(arg('collected', 0));
  const hour = arg('hour') === undefined ? CHECKPOINT_HOURS[checkpoint] : Number(arg('hour'));
  const dryRun = flag('dry-run');
  const approvalMode = (flag('auto') || process.env.AGENT_APPROVAL_MODE === 'automatic') ? 'automatic' : 'manual';

  const plan = coordinator.planCheckpoint(checkpoint, { collectedToday: collected, hour });

  console.log(plan.summary);
  console.log(`approval mode: ${approvalMode}${approvalMode === 'manual' ? ' (dispatcher will require a person; pass --auto to change that deliberately)' : ' (operator-authorized)'}`);
  if (plan.gatesClosed.length) console.log(`gates closed: ${plan.gatesClosed.join(', ')} — work is drafted, nothing leaves.`);
  console.log('');

  if (dryRun) {
    console.log('--dry-run: not dispatching. Assignments that would be sent to the queue:');
    for (const a of plan.assignments) console.log(`  ${a.impact}  ${a.roleId.padEnd(20)}${a.action.padEnd(26)}→ ${a.queue}`);
    return;
  }

  // The real dispatcher. Required lazily so --dry-run works in an environment
  // with no bullmq installed.
  const { dispatchAction } = require('../lib/openai-action-dispatcher');
  const run = await runner.runCheckpoint(plan, { dispatch: dispatchAction, approvalMode });

  console.log(run.report.verdict);
  for (const note of run.report.notes) console.log(`  · ${note}`);
  console.log('');
  for (const o of run.outcomes) {
    console.log(`  ${o.status.padEnd(11)} ${o.roleId.padEnd(20)}${o.action.padEnd(26)}${o.detail || ''}`);
  }

  const stored = await persist(run);
  console.log('');
  if (stored.stored === 'redis') console.log(`Run recorded in Redis as ${stored.key} (30-day TTL).`);
  else if (stored.stored === 'local-file') console.log(`No Redis (${stored.redisError}). Run recorded locally at ${stored.key} — ephemeral on Render.`);
  else console.log(`WARNING: run was not recorded anywhere (${stored.redisError}; ${stored.writeError}).`);

  // A checkpoint that dispatched nothing is not a success.
  if (run.report.dispatched === 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Checkpoint failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { CHECKPOINT_HOURS, persist };

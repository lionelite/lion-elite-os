'use strict';

// Instant kill switch for automated outreach sending (owner-authorized
// unattended mode — see docs/automated-outreach.md).
//
// Two layers stop sending:
//  1. OUTREACH_SEND_ENABLED env var (lib/email-delivery.js) — hard gate,
//     needs a Render redeploy (~1 minute) to change.
//  2. This Redis flag — takes effect on the very next job, no redeploy.
//     Set/cleared via the executive API or scripts/outreach-kill-switch.js.
//
// Fail-closed: if the flag can't be READ, sending is treated as halted.

const { getRedis, ensureConnected } = require('./redis');
const { log } = require('./observability');

const KILL_SWITCH_KEY = 'outreach:sending_halted';

async function resolveClient(injected) {
  if (injected) return injected;
  return ensureConnected(getRedis());
}

async function isHalted(injectedClient) {
  try {
    const redis = await resolveClient(injectedClient);
    return Boolean(await redis.get(KILL_SWITCH_KEY));
  } catch (error) {
    log('warn', 'kill_switch.read_failed', { message: error.message });
    return true; // unreadable switch = do not send
  }
}

async function halt(reason = 'manual halt', by = 'unknown', injectedClient) {
  const redis = await resolveClient(injectedClient);
  const state = { halted: true, reason, by, at: new Date().toISOString() };
  await redis.set(KILL_SWITCH_KEY, JSON.stringify(state));
  log('warn', 'kill_switch.halted', state);
  return state;
}

async function resume(by = 'unknown', injectedClient) {
  const redis = await resolveClient(injectedClient);
  await redis.del(KILL_SWITCH_KEY);
  const state = { halted: false, by, at: new Date().toISOString() };
  log('info', 'kill_switch.resumed', state);
  return state;
}

async function status(injectedClient) {
  try {
    const redis = await resolveClient(injectedClient);
    const raw = await redis.get(KILL_SWITCH_KEY);
    if (!raw) return { halted: false };
    try {
      return { halted: true, ...JSON.parse(raw) };
    } catch {
      return { halted: true, reason: 'unparseable state', raw: String(raw).slice(0, 200) };
    }
  } catch (error) {
    return { halted: true, degraded: true, error: error.message };
  }
}

module.exports = { KILL_SWITCH_KEY, isHalted, halt, resume, status };

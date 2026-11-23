'use strict';

const { runOutreach } = require('./outreach-engine');

const intervalMs = Math.max(60000, Number(process.env.BLUESKY_OUTREACH_INTERVAL_MS || 300000));
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await runOutreach();
  } catch (error) {
    console.error(`[outreach-worker] ${error.stack || error.message}`);
  } finally {
    running = false;
  }
}

console.log(`[outreach-worker] Starting; interval=${intervalMs}ms`);
tick();
setInterval(tick, intervalMs);

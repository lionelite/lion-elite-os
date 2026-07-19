'use strict';

const { spawn } = require('child_process');
const path = require('path');

function hasBlueskyCredentials() {
  return Boolean(
    String(process.env.BLUESKY_HANDLE || '').trim() &&
    String(process.env.BLUESKY_APP_PASSWORD || '').trim()
  );
}

function startManaged(name, script, args = []) {
  let stopping = false;
  let child = null;

  const launch = () => {
    if (stopping) return;
    child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      env: process.env,
      stdio: 'inherit'
    });

    child.on('exit', (code, signal) => {
      if (stopping) return;
      console.error(`[bootstrap] ${name} exited code=${code} signal=${signal || 'none'}; restarting in 5s`);
      setTimeout(launch, 5000).unref();
    });
  };

  launch();

  return () => {
    stopping = true;
    if (child && !child.killed) child.kill('SIGTERM');
  };
}

const stopHandlers = [];

if (hasBlueskyCredentials()) {
  // Explicit owner activation: credentials present means Bluesky automation should run.
  if (process.env.BLUESKY_OUTREACH_ENABLED == null) process.env.BLUESKY_OUTREACH_ENABLED = 'true';
  if (process.env.BLUESKY_OUTREACH_DRY_RUN == null) process.env.BLUESKY_OUTREACH_DRY_RUN = 'false';
  if (process.env.BLUESKY_OUTREACH_DELIVERY_MODE == null) process.env.BLUESKY_OUTREACH_DELIVERY_MODE = 'direct';

  console.log('[bootstrap] Bluesky credentials detected; starting continuous listener and direct outreach worker.');
  stopHandlers.push(startManaged('bluesky-listener', 'social-listening/src/monitor.js', ['--no-model', '--quiet']));
  stopHandlers.push(startManaged('bluesky-outreach-worker', 'social-listening/src/outreach-worker.js'));
} else {
  console.log('[bootstrap] Bluesky credentials not configured; social automation not started.');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const stop of stopHandlers) stop();
  });
}

require('./server');

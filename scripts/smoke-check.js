'use strict';

// Starts each deployed entry point as a real child process for a short
// window and confirms it doesn't crash on require()/startup. Neither
// `node --check` (syntax only) nor the unit test suite (imports lib/
// modules directly, bypassing entry-point require chains) would have
// caught a missing-module or wrong-export regression - this would have.

const { spawn } = require('child_process');
const path = require('path');

const ENTRY_POINTS = [
  'server.js',
  'outreach-server-postgres.js',
  'executive-orchestrator.js',
  'integration-gateway-server.js',
  path.join('workers', 'outreach-worker.js'),
  path.join('workers', 'executive-worker.js'),
  path.join('workers', 'integration-worker.js'),
  path.join('workers', 'discovery-worker.js')
];

const STARTUP_WINDOW_MS = 2500;

function smokeTest(entry) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: '0',
        OUTREACH_PORT: '0',
        WORKER_HEALTH_PORT: '0'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    let settled = false;

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) return; // killed by us after the window = clean startup
      resolve({ entry, ok: code === 0, stderr });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ entry, ok: true, stderr: '' });
    }, STARTUP_WINDOW_MS);
  });
}

async function main() {
  let failed = false;

  for (const entry of ENTRY_POINTS) {
    process.stdout.write(`Smoke testing ${entry} ... `);
    const result = await smokeTest(entry);
    if (result.ok) {
      console.log('OK');
    } else {
      failed = true;
      console.log('FAILED');
      console.error(result.stderr || '(no stderr captured)');
    }
  }

  if (failed) {
    console.error('\nOne or more entry points crashed on startup.');
    process.exit(1);
  }

  console.log('\nAll entry points started cleanly.');
}

main();

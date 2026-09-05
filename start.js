'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { installAutomaticCoachingInvites } = require('./lib/coaching/invite-email-bootstrap');

// Temporary review mode: keep coaching usable even if the Render database
// is not attached yet. This is intentionally non-persistent and should be
// removed once the owner finishes reviewing the app.
if (!process.env.DATABASE_URL) process.env.COACHING_DEMO_MODE = 'true';

// Temporary owner preview access, for the throwaway in-memory store only.
//
// This value is committed in a public repository, and since coaches gained
// identities it would bootstrap the OWNER account — the role that sees every
// coach's clients and can issue and rotate their access tokens. It is
// therefore confined to demo mode, where the store is non-persistent and holds
// no real client data. A deployment with a real database and no configured
// token now refuses coach sign-in (401) instead of accepting a public one.
if (!process.env.COACH_PORTAL_ADMIN_TOKEN && process.env.COACHING_DEMO_MODE === 'true') {
  process.env.COACH_PORTAL_ADMIN_TOKEN = 'preview-mode-enabled';
}

installAutomaticCoachingInvites();

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

// The listener is read-only and safe to run on credentials alone. Posting is
// not: it is started only when BLUESKY_OUTREACH_ENABLED is explicitly 'true',
// so credentials appearing in the dashboard can never by themselves put replies
// on other people's posts. This bootstrap no longer forces ENABLED/DRY_RUN/
// DELIVERY_MODE — the engine's own fail-closed defaults apply.
if (hasBlueskyCredentials()) {
  console.log('[bootstrap] Bluesky credentials detected; starting read-only listener.');
  stopHandlers.push(startManaged('bluesky-listener', 'social-listening/src/monitor.js', ['--no-model', '--quiet']));

  if (String(process.env.BLUESKY_OUTREACH_ENABLED || '').toLowerCase() === 'true') {
    const dryRun = String(process.env.BLUESKY_OUTREACH_DRY_RUN || 'true').toLowerCase() !== 'false';
    console.log(`[bootstrap] Bluesky outreach explicitly enabled; starting worker (dryRun=${dryRun}).`);
    stopHandlers.push(startManaged('bluesky-outreach-worker', 'social-listening/src/outreach-worker.js'));
  } else {
    console.log('[bootstrap] Bluesky outreach not enabled; reply worker not started. Set BLUESKY_OUTREACH_ENABLED=true to enable.');
  }
} else {
  console.log('[bootstrap] Bluesky credentials not configured; social automation not started.');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const stop of stopHandlers) stop();
  });
}

require('./server');

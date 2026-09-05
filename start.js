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

// Lead discovery needs no Bluesky account. The listener consumes Bluesky's
// PUBLIC Jetstream firehose and reads no credential anywhere in monitor.js,
// jetstream.js, store.js, classifier.js or universal-lead-store.js — only the
// reply path authenticates (com.atproto.server.createSession). Gating discovery
// behind hasBlueskyCredentials() therefore blocked it on something it never
// used, which is why no lead had ever been found. It now runs by default and
// can be turned off with BLUESKY_LISTENER_ENABLED=false.
//
// Posting keeps both explicit switches and additionally needs credentials, so
// nothing here can put a reply on anyone's post.
const listenerEnabled = String(process.env.BLUESKY_LISTENER_ENABLED || 'true').toLowerCase() !== 'false';

if (listenerEnabled) {
  console.log('[bootstrap] Starting read-only Bluesky listener (public firehose; no account required).');
  stopHandlers.push(startManaged('bluesky-listener', 'social-listening/src/monitor.js', ['--no-model', '--quiet']));
} else {
  console.log('[bootstrap] Bluesky listener disabled by BLUESKY_LISTENER_ENABLED=false.');
}

if (!hasBlueskyCredentials()) {
  console.log('[bootstrap] No Bluesky credentials; reply worker not started (discovery is unaffected).');
} else if (String(process.env.BLUESKY_OUTREACH_ENABLED || '').toLowerCase() !== 'true') {
  console.log('[bootstrap] Bluesky outreach not enabled; reply worker not started. Set BLUESKY_OUTREACH_ENABLED=true to enable.');
} else {
  const dryRun = String(process.env.BLUESKY_OUTREACH_DRY_RUN || 'true').toLowerCase() !== 'false';
  console.log(`[bootstrap] Bluesky outreach explicitly enabled; starting worker (dryRun=${dryRun}).`);
  stopHandlers.push(startManaged('bluesky-outreach-worker', 'social-listening/src/outreach-worker.js'));
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const stop of stopHandlers) stop();
  });
}

require('./server');

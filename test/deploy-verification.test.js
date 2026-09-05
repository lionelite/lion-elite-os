'use strict';

// The deploy pipeline's honesty contract.
//
// render-deploy.yml verifies a deploy by polling /health until it reports the
// commit that was just merged. That only works while server.js actually
// publishes the commit, so the two are pinned together here. Without this, a
// refactor could drop the field and every deploy would silently go back to
// "hook accepted" being reported as success — which is how the listener sat
// dead and every care-plan write threw, unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'render-deploy.yml'), 'utf8');

test('health reports the commit Render deployed', () => {
  assert.ok(
    server.includes('RENDER_GIT_COMMIT'),
    'server.js must read RENDER_GIT_COMMIT; it is what makes a deploy verifiable'
  );
  const healthHandler = server.slice(server.indexOf("app.get('/health'"), server.indexOf("app.get('/health'") + 900);
  assert.ok(healthHandler.includes('commit:'), '/health must expose the deployed commit');
});

test('health answers whether the listener runs and keeps its leads', () => {
  const healthHandler = server.slice(server.indexOf("app.get('/health'"), server.indexOf("app.get('/health'") + 900);
  for (const field of ['listenerEnabled', 'durableLeadStorage', 'replyWorkerEnabled']) {
    assert.ok(healthHandler.includes(field), `/health must report ${field}`);
  }
});

test('health never returns a credential value', () => {
  const healthHandler = server.slice(server.indexOf("app.get('/health'"), server.indexOf("app.get('/health'") + 900);
  // Every credential must be reduced to a boolean before it leaves the process.
  for (const secret of ['BLUESKY_APP_PASSWORD', 'BLUESKY_HANDLE', 'DATABASE_URL']) {
    const mentions = healthHandler.split(secret).length - 1;
    if (mentions === 0) continue;
    assert.ok(
      new RegExp(`Boolean\\([^)]*${secret}|${secret}[^)]*\\)\\s*&&|process\\.env\\.${secret}\\s*&&`).test(healthHandler),
      `${secret} may only be reported as a boolean, never as a value`
    );
  }
  assert.ok(!/RESEND_API_KEY|STRIPE_SECRET_KEY|COACH_PORTAL_ADMIN_TOKEN/.test(healthHandler),
    '/health must not reference send or admin credentials at all');
});

test('the deploy workflow verifies the served commit rather than the hook response', () => {
  assert.ok(workflow.includes('Verify the deploy actually shipped this commit'));
  assert.ok(workflow.includes('EXPECTED_SHA: ${{ github.sha }}'), 'must compare against the merged commit');
  assert.ok(workflow.includes('/health'), 'verification must poll the service itself');
  // A service that never comes up is a failed deploy, not a warning.
  assert.ok(workflow.includes('never responded. The deploy did not come up'));
});

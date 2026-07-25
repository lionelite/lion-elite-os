'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { leadAutomationReadiness } = require('../lib/lead-automation-readiness');

test('reports every lead automation path unavailable when configuration is absent', () => {
  assert.deepEqual(leadAutomationReadiness({}), {
    listenerReady: false,
    outreachReady: false,
    digestReady: false,
    checks: {
      databaseConfigured: false,
      blueskyCredentialsConfigured: false,
      botIdentityConfigured: false,
      outreachEnabled: false,
      outreachDryRun: true
    }
  });
});

test('reports listener ready without claiming live outreach', () => {
  const readiness = leadAutomationReadiness({
    DATABASE_URL: 'postgres://configured',
    BLUESKY_HANDLE: 'lionelite.example',
    BLUESKY_APP_PASSWORD: 'configured'
  });

  assert.equal(readiness.listenerReady, true);
  assert.equal(readiness.outreachReady, false);
  assert.equal(readiness.checks.outreachDryRun, true);
});

test('requires identity, explicit enablement, and dry-run off for outreach readiness', () => {
  const readiness = leadAutomationReadiness({
    DATABASE_URL: 'postgres://configured',
    BLUESKY_HANDLE: 'lionelite.example',
    BLUESKY_APP_PASSWORD: 'configured',
    BLUESKY_BOT_DID: 'did:plc:configured',
    BLUESKY_OUTREACH_ENABLED: 'true',
    BLUESKY_OUTREACH_DRY_RUN: 'false'
  });

  assert.equal(readiness.listenerReady, true);
  assert.equal(readiness.outreachReady, true);
});

test('requires the complete digest delivery configuration', () => {
  const partial = leadAutomationReadiness({
    DATABASE_URL: 'postgres://configured',
    RESEND_API_KEY: 'configured',
    OUTREACH_FROM_EMAIL: 'sender@example.com'
  });
  assert.equal(partial.digestReady, false);

  const complete = leadAutomationReadiness({
    DATABASE_URL: 'postgres://configured',
    RESEND_API_KEY: 'configured',
    OUTREACH_FROM_EMAIL: 'sender@example.com',
    LEAD_DIGEST_TO: 'owner@example.com'
  });
  assert.equal(complete.digestReady, true);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessage, keyFor, isExplicitlyTagged, runOutreach } = require('../src/outreach-engine');

test('buildMessage uses configured suggested opener', () => {
  const entry = {
    post: { did: 'did:plc:test', rkey: 'abc', url: 'https://example.com', text: 'Need help scaling' },
    match: { audience: 'business-scaling', score: 80, suggestedOpener: 'Custom opener' }
  };
  assert.equal(buildMessage(entry), 'Custom opener');
});

test('buildMessage falls back to audience-specific copy', () => {
  const entry = {
    post: { did: 'did:plc:test', rkey: 'abc', url: 'https://example.com', text: 'Need help scaling' },
    match: { audience: 'business-scaling', score: 80 }
  };
  assert.match(buildMessage(entry), /LionOS/);
});

test('keyFor produces stable per-post per-audience dedupe key', () => {
  const entry = {
    post: { did: 'did:plc:test', rkey: 'abc' },
    match: { audience: 'business-scaling' }
  };
  assert.equal(keyFor(entry), 'did:plc:test/abc/business-scaling');
});

test('requires an explicit structured tag of the configured bot DID', () => {
  const tagged = {
    post: { did: 'did:plc:prospect', mentionedDids: ['did:plc:lionbot'] }
  };
  assert.equal(isExplicitlyTagged(tagged, 'did:plc:lionbot'), true);
  assert.equal(isExplicitlyTagged({ post: { did: 'did:plc:prospect', mentionedDids: [] } }, 'did:plc:lionbot'), false);
  assert.equal(isExplicitlyTagged(tagged, ''), false);
});

test('does not treat the bot tagging itself as prospect opt-in', () => {
  const selfPost = {
    post: { did: 'did:plc:lionbot', mentionedDids: ['did:plc:lionbot'] }
  };
  assert.equal(isExplicitlyTagged(selfPost, 'did:plc:lionbot'), false);
});

// Posting to Bluesky must never arm itself. Credentials appearing in the
// dashboard previously flipped both `enabled` and `dryRun` to live, so adding
// BLUESKY_HANDLE/BLUESKY_APP_PASSWORD silently started replying to strangers.
test('outreach stays disabled when credentials exist but nothing was enabled', async t => {
  const saved = {
    handle: process.env.BLUESKY_HANDLE,
    password: process.env.BLUESKY_APP_PASSWORD,
    enabled: process.env.BLUESKY_OUTREACH_ENABLED,
    dryRun: process.env.BLUESKY_OUTREACH_DRY_RUN
  };
  process.env.BLUESKY_HANDLE = 'lionelite.test';
  process.env.BLUESKY_APP_PASSWORD = 'app-password';
  delete process.env.BLUESKY_OUTREACH_ENABLED;
  delete process.env.BLUESKY_OUTREACH_DRY_RUN;
  t.after(() => {
    for (const [key, value] of Object.entries({
      BLUESKY_HANDLE: saved.handle,
      BLUESKY_APP_PASSWORD: saved.password,
      BLUESKY_OUTREACH_ENABLED: saved.enabled,
      BLUESKY_OUTREACH_DRY_RUN: saved.dryRun
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const summary = await runOutreach();
  assert.equal(summary.disabled, true, 'credentials alone must not enable posting');
  assert.equal(summary.sent, 0);
});

test('enabling outreach without clearing dry run still posts nothing', async t => {
  const saved = {
    handle: process.env.BLUESKY_HANDLE,
    password: process.env.BLUESKY_APP_PASSWORD,
    enabled: process.env.BLUESKY_OUTREACH_ENABLED,
    dryRun: process.env.BLUESKY_OUTREACH_DRY_RUN,
    botDid: process.env.BLUESKY_BOT_DID
  };
  process.env.BLUESKY_HANDLE = 'lionelite.test';
  process.env.BLUESKY_APP_PASSWORD = 'app-password';
  process.env.BLUESKY_OUTREACH_ENABLED = 'true';
  delete process.env.BLUESKY_OUTREACH_DRY_RUN;
  // Set so the run never needs the network to resolve a handle.
  process.env.BLUESKY_BOT_DID = 'did:plc:testbot';
  t.after(() => {
    for (const [key, value] of Object.entries({
      BLUESKY_HANDLE: saved.handle,
      BLUESKY_APP_PASSWORD: saved.password,
      BLUESKY_OUTREACH_ENABLED: saved.enabled,
      BLUESKY_OUTREACH_DRY_RUN: saved.dryRun,
      BLUESKY_BOT_DID: saved.botDid
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const summary = await runOutreach();
  assert.equal(summary.disabled, false);
  assert.equal(summary.dryRun, true, 'dry run must stay on until explicitly turned off');
});

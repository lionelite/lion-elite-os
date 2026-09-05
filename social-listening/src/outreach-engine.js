'use strict';

const fs = require('fs');
const path = require('path');
const { loadRecentMatches, DATA_DIR } = require('./store');
const { sendReply } = require('./bluesky-delivery');

const STATE_FILE = path.join(DATA_DIR, 'outreach-state.json');
const LOG_FILE = path.join(DATA_DIR, 'outreach-log.jsonl');
let resolvedBotDid = null;

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  return value == null ? fallback : String(value).toLowerCase() === 'true';
}

function numEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { contacted: {}, daily: {} }; }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function logEvent(event) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function keyFor(entry) {
  return `${entry.post.did}/${entry.post.rkey}/${entry.match.audience}`;
}

function isExplicitlyTagged(entry, botDid) {
  const expected = String(botDid || '').trim();
  if (!expected || entry?.post?.did === expected) return false;
  return Array.isArray(entry?.post?.mentionedDids) && entry.post.mentionedDids.includes(expected);
}

async function resolveBotDid() {
  const configured = String(process.env.BLUESKY_BOT_DID || '').trim();
  if (configured) return configured;
  if (resolvedBotDid) return resolvedBotDid;

  const handle = String(process.env.BLUESKY_HANDLE || '').trim().replace(/^@/, '');
  if (!handle) throw new Error('BLUESKY_HANDLE is required to resolve the Bluesky bot DID');

  const url = new URL('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle');
  url.searchParams.set('handle', handle);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.did) {
    throw new Error(`Could not resolve Bluesky handle ${handle} to a DID`);
  }
  resolvedBotDid = data.did;
  console.log(`[outreach] Resolved ${handle} -> ${resolvedBotDid}`);
  return resolvedBotDid;
}

function buildMessage(entry) {
  const opener = String(entry.match.suggestedOpener || '').trim();
  if (opener) return opener;
  if (entry.match.audience === 'business-scaling') {
    return 'Saw your post about scaling. LionOS helps businesses automate lead generation, CRM, follow-up, sales systems, marketing automation, and operations. Happy to compare notes on the bottleneck you are trying to solve.';
  }
  if (entry.match.audience === 'personal-training') {
    return 'Saw your post. Lion Elite Beauty is built around structured coaching, accountability, and a personalized plan. Happy to help you map out the next step.';
  }
  return 'Saw your post and thought it may be relevant to what we do at Lion Elite. Happy to connect and learn more about what you are looking for.';
}

async function deliverWebhook(entry, message) {
  const webhook = process.env.OUTREACH_WEBHOOK_URL;
  if (!webhook) throw new Error('OUTREACH_WEBHOOK_URL is required for webhook delivery mode');
  const headers = { 'content-type': 'application/json' };
  if (process.env.OUTREACH_WEBHOOK_TOKEN) headers.authorization = `Bearer ${process.env.OUTREACH_WEBHOOK_TOKEN}`;
  const response = await fetch(webhook, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: 'bluesky-listener', action: 'outreach', audience: entry.match.audience, score: entry.match.score,
      prospect: { did: entry.post.did, rkey: entry.post.rkey, postUrl: entry.post.url, postText: entry.post.text },
      message
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`delivery failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return { ok: true, mode: 'webhook', status: response.status };
}

async function deliver(entry, message, dryRun) {
  if (dryRun) return { ok: true, dryRun: true };
  const mode = String(process.env.BLUESKY_OUTREACH_DELIVERY_MODE || 'direct').toLowerCase();
  if (mode === 'direct') return sendReply(entry, message);
  if (mode === 'webhook') return deliverWebhook(entry, message);
  throw new Error(`Unsupported BLUESKY_OUTREACH_DELIVERY_MODE: ${mode}`);
}

async function runOutreach() {
  // Fail closed, matching every other send path in this repo
  // (OUTREACH_SEND_ENABLED, SMS_SEND_ENABLED, SOCIAL_PUBLISH_ENABLED): posting
  // requires a deliberate human opt-in, and the presence of credentials is not
  // one. Previously both defaults keyed off credentials, so adding
  // BLUESKY_HANDLE/BLUESKY_APP_PASSWORD in the dashboard silently began posting
  // live replies with no separate enable step.
  const enabled = boolEnv('BLUESKY_OUTREACH_ENABLED', false);
  const dryRun = boolEnv('BLUESKY_OUTREACH_DRY_RUN', true);
  const minScore = numEnv('BLUESKY_OUTREACH_MIN_SCORE', 60);
  const maxPerRun = numEnv('BLUESKY_OUTREACH_MAX_PER_RUN', 5);
  const maxPerDay = numEnv('BLUESKY_OUTREACH_MAX_PER_DAY', 25);
  const allowedAudiences = new Set(
    String(process.env.BLUESKY_OUTREACH_AUDIENCES || 'business-scaling,personal-training')
      .split(',').map((x) => x.trim()).filter(Boolean)
  );

  if (!enabled) {
    console.log('[outreach] Disabled. Set BLUESKY_OUTREACH_ENABLED=true to enable.');
    return { disabled: true, attempted: 0, sent: 0 };
  }

  if (dryRun) {
    console.log('[outreach] DRY RUN. Nothing is posted to Bluesky until BLUESKY_OUTREACH_DRY_RUN=false.');
  }

  const botDid = await resolveBotDid();
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = Number(state.daily[today] || 0);
  const cap = Math.max(0, Math.min(maxPerRun, maxPerDay - sentToday));
  const entries = loadRecentMatches({ days: 7 })
    .filter((entry) => isExplicitlyTagged(entry, botDid))
    .filter((entry) => !entry?.match?.doNotEngage)
    .filter((entry) => allowedAudiences.has(entry?.match?.audience))
    .filter((entry) => Number(entry?.match?.score || 0) >= minScore)
    .sort((a, b) => Number(b.match.score || 0) - Number(a.match.score || 0));

  let attempted = 0;
  let sent = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (sent >= cap) break;
    const key = keyFor(entry);
    if (state.contacted[key]) { skipped += 1; continue; }
    const message = buildMessage(entry);
    attempted += 1;
    try {
      const result = await deliver(entry, message, dryRun);
      if (!dryRun) {
        state.contacted[key] = { at: new Date().toISOString(), postUrl: entry.post.url, audience: entry.match.audience, result };
        state.daily[today] = Number(state.daily[today] || 0) + 1;
        saveState(state);
      }
      logEvent({ status: dryRun ? 'dry-run' : 'sent', key, message, score: entry.match.score, result });
      sent += 1;
      console.log(`[outreach] ${dryRun ? 'DRY RUN' : 'SENT'} ${key} score=${entry.match.score}`);
    } catch (error) {
      logEvent({ status: 'error', key, message, error: error.message });
      console.error(`[outreach] ERROR ${key}: ${error.message}`);
    }
  }

  return { disabled: false, dryRun, attempted, sent, skipped, cap };
}

if (require.main === module) {
  runOutreach()
    .then((summary) => console.log('[outreach] Summary', summary))
    .catch((error) => {
      console.error(`[outreach] FATAL: ${error.stack || error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { runOutreach, buildMessage, keyFor, isExplicitlyTagged, deliver, resolveBotDid };

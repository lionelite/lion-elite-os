#!/usr/bin/env node
'use strict';

// Bluesky firehose listening monitor — READ-ONLY.
//
// Usage: node social-listening/src/monitor.js [options]
//   --audience=research-peptides|personal-training  (repeatable; default both)
//   --min-score=40        minimum keyword score to surface
//   --no-model            skip Ollama refinement even if available
//   --quiet               only print matches, not periodic stats
//
// Streams public posts from Jetstream, classifies them against the
// audience profiles, optionally refines matches with a local Ollama
// model, prints them live, and appends them to social-listening/data/
// for the review dashboard (review-server.js).
//
// This tool has no Bluesky credentials and no write path to any social
// platform. Engagement is a human decision made outside this tool.

const { JetstreamListener, isEnglish } = require('./jetstream');
const { classifyPost } = require('./classifier');
const { AUDIENCE_KEYS } = require('./audience-profiles');
const { resolveOllamaConfig, checkOllama, analyzeIntent, applyModelAssessment } = require('./ollama-intent');
const { appendMatch, DATA_DIR } = require('./store');

function parseArgs(argv) {
  const args = { audiences: [], minScore: 40, useModel: true, quiet: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--audience=')) args.audiences.push(arg.slice('--audience='.length));
    else if (arg.startsWith('--min-score=')) args.minScore = Number(arg.slice('--min-score='.length));
    else if (arg === '--no-model') args.useModel = false;
    else if (arg === '--quiet') args.quiet = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.audiences.length === 0) args.audiences = [...AUDIENCE_KEYS];
  for (const audience of args.audiences) {
    if (!AUDIENCE_KEYS.includes(audience)) {
      throw new Error(`Unknown audience: ${audience}. Valid: ${AUDIENCE_KEYS.join(', ')}`);
    }
  }
  if (!Number.isFinite(args.minScore)) throw new Error('--min-score must be a number');
  return args;
}

function formatMatch(post, match) {
  const flag = match.doNotEngage ? ' ⛔ DO NOT ENGAGE' : '';
  const model = match.model
    ? ` model=${match.model.intent}@${match.model.confidence.toFixed(2)}${match.model.humanUse ? ' human-use' : ''}`
    : '';
  const lines = [
    `\n━━━ ${match.audience} score=${match.score}${model}${flag}`,
    `  ${post.text.replace(/\s+/g, ' ').slice(0, 240)}`,
    `  terms: subject=[${match.matched.subject.join(', ')}] intent=[${match.matched.intent.join(', ')}]`,
    `  ${post.url}`
  ];
  if (match.doNotEngage) {
    lines.push(`  reason: ${match.doNotEngageReason}`);
  } else if (match.suggestedOpener) {
    lines.push(`  suggested opener (manual use only): ${match.suggestedOpener}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const ollamaConfig = resolveOllamaConfig();
  let modelAvailable = false;
  if (args.useModel) {
    modelAvailable = await checkOllama(ollamaConfig);
    console.log(modelAvailable
      ? `[listen] Local model: ${ollamaConfig.model} via ${ollamaConfig.url}`
      : `[listen] Ollama not reachable at ${ollamaConfig.url} — keyword-only mode.`);
  } else {
    console.log('[listen] Model refinement disabled (--no-model).');
  }
  console.log(`[listen] Audiences: ${args.audiences.join(', ')} (min score ${args.minScore})`);
  console.log(`[listen] Matches append to ${DATA_DIR} — run 'npm run listen:review' for the dashboard.`);
  console.log('[listen] Read-only monitor: this tool never posts, replies, or DMs.');

  const stats = { posts: 0, english: 0, matches: 0, doNotEngage: 0, startedAt: Date.now() };
  const seen = new Set(); // did+rkey dedupe across reconnect replays

  const listener = new JetstreamListener();
  listener.on('status', (message) => console.log(`[listen] ${message}`));
  listener.on('post', async (post) => {
    stats.posts += 1;
    if (!isEnglish(post)) return;
    stats.english += 1;

    const { relevant, matches } = classifyPost(post.text, { audiences: args.audiences });
    if (!relevant) return;

    const key = `${post.did}/${post.rkey}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 50000) seen.clear();

    for (let match of matches) {
      if (match.score < args.minScore) continue;
      if (modelAvailable) {
        match = applyModelAssessment(match, await analyzeIntent(post.text, ollamaConfig));
      }
      stats.matches += 1;
      if (match.doNotEngage) stats.doNotEngage += 1;
      console.log(formatMatch(post, match));
      appendMatch({
        seenAt: new Date().toISOString(),
        post: {
          did: post.did,
          rkey: post.rkey,
          url: post.url,
          text: post.text,
          createdAt: post.createdAt,
          isReply: post.isReply
        },
        match
      });
    }
  });

  if (!args.quiet) {
    setInterval(() => {
      const minutes = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
      console.log(
        `[listen] ${minutes}min: ${listener.eventCount} events, ${stats.posts} posts, ` +
        `${stats.english} english, ${stats.matches} matches (${stats.doNotEngage} do-not-engage)`
      );
    }, 60000).unref();
  }

  process.on('SIGINT', () => {
    console.log('\n[listen] Stopping.');
    listener.stop();
    process.exit(0);
  });

  listener.start();
}

main().catch((error) => {
  console.error(`[listen] FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});

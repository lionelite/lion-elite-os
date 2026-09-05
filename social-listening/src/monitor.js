#!/usr/bin/env node
'use strict';

// Bluesky firehose listening monitor.
//
// Streams public posts from Jetstream, captures broad niche-agnostic lead
// intent into the durable LionOS prospect database, and separately keeps the
// existing brand-specific audience classification used by Lion Elite.

const { JetstreamListener, isEnglish } = require('./jetstream');
const { classifyPost } = require('./classifier');
const { AUDIENCE_KEYS } = require('./audience-profiles');
const { resolveOllamaConfig, checkOllama, analyzeIntent, applyModelAssessment } = require('./ollama-intent');
const { appendMatch, DATA_DIR } = require('./store');
const { detectUniversalLead } = require('./universal-lead-intelligence');
const { persistUniversalLead, persistAudienceMatch } = require('./universal-lead-store');

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
    lines.push(`  suggested opener: ${match.suggestedOpener}`);
  }
  return lines.join('\n');
}

function universalMatch(lead) {
  return {
    audience: 'universal-lead',
    brand: 'lionos',
    label: lead.niche,
    score: lead.opportunityScore,
    doNotEngage: false,
    lowPriority: lead.opportunityScore < 50,
    matched: {
      subject: [lead.niche],
      intent: lead.intentSignals
    },
    universalLead: true,
    opportunity: lead,
    suggestedOpener: null
  };
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
  console.log(`[listen] Brand audiences: ${args.audiences.join(', ')} (min score ${args.minScore})`);
  console.log('[listen] Universal lead intelligence: ON — broad buying/hiring/help-seeking intent is categorized and scored across niches.');
  console.log(`[listen] Local match mirror: ${DATA_DIR}`);
  console.log(`[listen] Durable lead storage: ${process.env.DATABASE_URL ? 'PostgreSQL ON' : 'PostgreSQL unavailable; local mirror only'}`);

  const stats = {
    posts: 0,
    english: 0,
    matches: 0,
    universalLeads: 0,
    durableLeads: 0,
    doNotEngage: 0,
    startedAt: Date.now()
  };
  const seen = new Set();

  const listener = new JetstreamListener();
  listener.on('status', (message) => console.log(`[listen] ${message}`));
  listener.on('post', async (post) => {
    stats.posts += 1;
    if (!isEnglish(post)) return;
    stats.english += 1;

    const key = `${post.did}/${post.rkey}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 50000) seen.clear();

    // Universal lane: capture lead intent regardless of the existing Lion Elite niche.
    const lead = detectUniversalLead(post.text);
    if (lead) {
      stats.universalLeads += 1;
      const match = universalMatch(lead);
      appendMatch({
        seenAt: new Date().toISOString(),
        post: {
          did: post.did,
          rkey: post.rkey,
          url: post.url,
          text: post.text,
          createdAt: post.createdAt,
          isReply: post.isReply,
          mentionedDids: Array.isArray(post.mentionedDids) ? post.mentionedDids : []
        },
        match
      });
      console.log(formatMatch(post, match));
      try {
        const stored = await persistUniversalLead(post, lead);
        if (stored.stored) stats.durableLeads += 1;
      } catch (error) {
        console.error(`[listen] Universal lead persistence error ${key}: ${error.message}`);
      }
    }

    // Existing brand-specific lanes remain available for LionOS/Beauty/Wellness workflows.
    const { relevant, matches } = classifyPost(post.text, { audiences: args.audiences });
    if (!relevant) return;

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
          isReply: post.isReply,
          mentionedDids: Array.isArray(post.mentionedDids) ? post.mentionedDids : []
        },
        match
      });

      // Durable storage for the brand lanes as well. Without this, the two
      // segments the business actually wants — people seeking a coach, and
      // coaches scaling their own business — existed only in a JSONL file
      // inside an ephemeral container and vanished on every restart.
      try {
        const stored = await persistAudienceMatch(post, match);
        if (stored.stored) stats.durableLeads += 1;
      } catch (error) {
        console.error(`[listen] Brand lead persistence error ${key}: ${error.message}`);
      }
    }
  });

  if (!args.quiet) {
    setInterval(() => {
      const minutes = ((Date.now() - stats.startedAt) / 60000).toFixed(1);
      console.log(
        `[listen] ${minutes}min: ${listener.eventCount} events, ${stats.posts} posts, ` +
        `${stats.english} english, ${stats.universalLeads} universal leads, ${stats.durableLeads} DB stores, ` +
        `${stats.matches} brand matches (${stats.doNotEngage} do-not-engage)`
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

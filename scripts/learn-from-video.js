#!/usr/bin/env node
'use strict';

// Video learning connection — turn a YouTube or Instagram video into a
// durable, source-cited lesson in the knowledge base.
//
//   node scripts/learn-from-video.js https://youtu.be/abc123
//   node scripts/learn-from-video.js https://youtu.be/abc123 --task="build an ad angle"
//   node scripts/learn-from-video.js https://www.instagram.com/reel/XYZ/ \
//       --transcript-file=./caption.txt
//   node scripts/learn-from-video.js --inbox        # process the queued links
//   node scripts/learn-from-video.js --inbox --dry-run
//
// Nothing here publishes, sends, or spends. It reads a video, writes a
// markdown lesson under knowledge/video-lessons/, and proposes work for the
// owner to accept or drop. When no transcript can be obtained the run says so
// and writes nothing — a lesson invented from a title would be worse than no
// lesson at all.

const fs = require('node:fs/promises');
const path = require('node:path');

const { parseVideoUrl } = require('../lib/video-learning/video-sources');
const { fetchTranscript } = require('../lib/video-learning/transcript-fetcher');
const { buildLesson } = require('../lib/video-learning/lesson-extractor');
const { proposeTasks } = require('../lib/video-learning/task-proposal');
const { saveLesson, DEFAULT_LESSON_DIR } = require('../lib/video-learning/lesson-store');
const { parseInbox, removeProcessed } = require('../lib/video-learning/intake-queue');

const DEFAULT_INBOX = path.join(DEFAULT_LESSON_DIR, 'inbox.md');

function parseArgs(argv) {
  const args = {
    urls: [],
    inbox: false,
    inboxPath: DEFAULT_INBOX,
    baseDir: process.cwd(),
    task: null,
    transcriptFile: null,
    saveTranscript: false,
    allowWhisper: true,
    dryRun: false,
    json: false,
    limit: null
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--inbox') args.inbox = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--save-transcript') args.saveTranscript = true;
    else if (arg === '--no-whisper') args.allowWhisper = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--task=')) args.task = arg.slice('--task='.length);
    else if (arg.startsWith('--transcript-file=')) args.transcriptFile = arg.slice('--transcript-file='.length);
    else if (arg.startsWith('--inbox-file=')) {
      args.inbox = true;
      args.inboxPath = arg.slice('--inbox-file='.length);
    } else if (arg.startsWith('--base-dir=')) args.baseDir = arg.slice('--base-dir='.length);
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else args.urls.push(arg);
  }

  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit < 1)) {
    throw new Error('--limit must be a positive number');
  }
  if (args.transcriptFile && args.urls.length !== 1) {
    throw new Error('--transcript-file applies to exactly one URL');
  }
  if (!args.inbox && args.urls.length === 0) args.help = true;
  return args;
}

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/learn-from-video.js <video-url> [--task="..."] [options]',
      '  node scripts/learn-from-video.js --inbox [options]',
      '',
      'Options:',
      '  --task="..."             what the lesson should be used for',
      '  --transcript-file=PATH   use a transcript you already have (single URL)',
      '  --inbox                  process every link queued in the inbox file',
      `  --inbox-file=PATH        inbox location (default ${DEFAULT_INBOX})`,
      '  --base-dir=PATH          repo root to write lessons into (default cwd)',
      '  --limit=N                stop after N videos',
      '  --save-transcript        also write the raw transcript to the repo',
      '  --no-whisper             never fall back to paid audio transcription',
      '  --dry-run                report what would happen, write nothing',
      '  --json                   machine-readable summary on stdout',
      '',
      'Supported: youtube.com/watch, youtu.be, /shorts, /live,',
      '           instagram.com/reel, /p, /tv'
    ].join('\n')
  );
}

/** Run one video all the way from URL to saved lesson. */
async function processItem(item, args) {
  const { source, task } = item;
  const label = source.canonicalUrl;

  let manualTranscript = null;
  if (args.transcriptFile) {
    manualTranscript = await fs.readFile(args.transcriptFile, 'utf8');
  }

  const result = await fetchTranscript({
    source,
    manualTranscript,
    allowWhisper: args.allowWhisper
  });

  if (result.status !== 'ok') {
    return {
      ok: false,
      url: label,
      sourceKey: source.sourceKey,
      reason: 'no transcript could be obtained',
      guidance: result.guidance,
      attempts: result.attempts
    };
  }

  const lesson = buildLesson({
    source,
    transcript: result.transcript,
    metadata: result.metadata,
    strategy: result.strategy,
    task
  });
  const proposals = proposeTasks(lesson);

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      url: label,
      sourceKey: source.sourceKey,
      strategy: result.strategy,
      wordCount: lesson.transcript.wordCount,
      proposalCount: proposals.length,
      internalOnly: lesson.reuse.internalOnly,
      attempts: result.attempts
    };
  }

  const saved = await saveLesson({
    lesson,
    proposals,
    baseDir: args.baseDir,
    transcriptText: result.transcript.text,
    saveTranscript: args.saveTranscript
  });

  return {
    ok: true,
    url: label,
    sourceKey: source.sourceKey,
    strategy: result.strategy,
    wordCount: lesson.transcript.wordCount,
    proposalCount: proposals.length,
    internalOnly: lesson.reuse.internalOnly,
    lessonPath: path.relative(process.cwd(), saved.lessonPath),
    attempts: result.attempts
  };
}

/** Build the work list from --inbox and/or positional URLs. */
async function collectItems(args) {
  const items = [];
  const problems = [];

  for (const url of args.urls) {
    const source = parseVideoUrl(url);
    if (!source) {
      problems.push({ raw: url, reason: 'not a supported YouTube or Instagram video URL' });
      continue;
    }
    items.push({ source, task: args.task });
  }

  if (args.inbox) {
    let inboxText;
    try {
      inboxText = await fs.readFile(args.inboxPath, 'utf8');
    } catch {
      problems.push({ raw: args.inboxPath, reason: 'inbox file not found' });
      return { items, problems, inboxText: null };
    }
    const parsed = parseInbox(inboxText);
    problems.push(...parsed.invalid.map((entry) => ({ raw: entry.raw, reason: entry.reason })));
    for (const entry of parsed.items) {
      items.push({ source: entry.source, task: entry.task ?? args.task });
    }
    return { items, problems, inboxText };
  }

  return { items, problems, inboxText: null };
}

function report(results, problems) {
  for (const problem of problems) {
    console.error(`[video-learning] skipped: ${problem.raw} — ${problem.reason}`);
  }
  for (const result of results) {
    if (!result.ok) {
      console.error(`[video-learning] FAILED ${result.url} — ${result.reason}`);
      for (const attempt of result.attempts || []) {
        console.error(`    ${attempt.strategy}: ${attempt.ok ? 'ok' : 'no'} — ${attempt.detail}`);
      }
      if (result.guidance) console.error(`    next step: ${result.guidance}`);
      continue;
    }
    const flags = [
      `${result.wordCount} words via ${result.strategy}`,
      `${result.proposalCount} proposals`,
      result.internalOnly ? 'internal-only wording' : 'wording clear'
    ].join(' · ');
    console.log(
      `[video-learning] ${result.dryRun ? 'DRY RUN ' : ''}${result.url} → ${flags}` +
        (result.lessonPath ? `\n    wrote ${result.lessonPath}` : '')
    );
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (error) {
    console.error(`[video-learning] ${error.message}`);
    usage();
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    usage();
    return;
  }

  const { items, problems, inboxText } = await collectItems(args);
  const queued = args.limit ? items.slice(0, args.limit) : items;

  if (queued.length === 0) {
    report([], problems);
    console.log('[video-learning] nothing to process.');
    process.exitCode = problems.length > 0 ? 1 : 0;
    return;
  }

  const results = [];
  for (const item of queued) {
    try {
      results.push(await processItem(item, args));
    } catch (error) {
      results.push({
        ok: false,
        url: item.source.canonicalUrl,
        sourceKey: item.source.sourceKey,
        reason: error.message,
        attempts: []
      });
    }
  }

  // Only clear inbox lines whose lesson actually landed on disk; a failed or
  // dry-run item stays queued so the next run retries it.
  const processedKeys = results
    .filter((result) => result.ok && !result.dryRun)
    .map((result) => result.sourceKey);
  if (args.inbox && inboxText !== null && !args.dryRun && processedKeys.length > 0) {
    await fs.writeFile(args.inboxPath, removeProcessed(inboxText, processedKeys), 'utf8');
  }

  if (args.json) {
    console.log(JSON.stringify({ results, problems }, null, 2));
  } else {
    report(results, problems);
  }

  const succeeded = results.filter((result) => result.ok).length;
  if (succeeded === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[video-learning] unexpected failure: ${error.stack || error.message}`);
  process.exitCode = 1;
});

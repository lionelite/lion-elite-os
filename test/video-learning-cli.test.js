'use strict';

// End-to-end coverage of scripts/learn-from-video.js — the entry point the
// owner actually runs. Every case drives the manual-transcript path, which
// short-circuits before any network call or binary probe, so these stay
// deterministic on a runner with or without yt-dlp and with or without
// internet access.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'learn-from-video.js');
const URL = 'https://youtu.be/dQw4w9WgXcQ';

const TRANSCRIPT = [
  '0:00 The biggest mistake people make is launching twelve creatives at once.',
  '0:12 Step one, pick a single winning hook and hold it for two weeks.',
  '0:24 Never change the budget and the creative in the same week.',
  '0:36 We held the CPM at $40 for 90 days and it returned 3x.',
  '0:48 I recommend testing 5 hooks per week in Meta Ads before you scale spend.'
].join('\n');

function withWorkspace(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-learning-cli-'));
  const transcriptFile = path.join(dir, 'transcript.txt');
  fs.writeFileSync(transcriptFile, TRANSCRIPT, 'utf8');
  try {
    return run({ dir, transcriptFile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('writes a lesson, an index, and a refreshed README', () => {
  withWorkspace(({ dir, transcriptFile }) => {
    const result = runCli([
      URL,
      `--transcript-file=${transcriptFile}`,
      `--base-dir=${dir}`,
      '--task=build a Meta Ads testing plan'
    ]);

    assert.equal(result.status, 0, result.stderr);

    const lessonDir = path.join(dir, 'knowledge', 'video-lessons');
    const lesson = fs.readFileSync(path.join(lessonDir, 'youtube-dQw4w9WgXcQ.md'), 'utf8');

    assert.match(lesson, /build a Meta Ads testing plan/, 'the owner instruction is recorded');
    assert.match(lesson, /&t=24\)/, 'lines link back to their timestamp');
    assert.match(lesson, /Blocked pending owner action:.*spend cap/, 'hard limits are surfaced');
    assert.match(lesson, /Nothing below has been executed/);

    const index = JSON.parse(fs.readFileSync(path.join(lessonDir, 'index.json'), 'utf8'));
    assert.equal(index.length, 1);
    assert.equal(index[0].sourceKey, 'youtube-dQw4w9WgXcQ');
    assert.equal(index[0].transcriptStrategy, 'manual');

    assert.match(fs.readFileSync(path.join(lessonDir, 'README.md'), 'utf8'), /youtube-dQw4w9WgXcQ\.md/);
  });
});

test('re-running the same video updates in place instead of duplicating', () => {
  withWorkspace(({ dir, transcriptFile }) => {
    const args = [URL, `--transcript-file=${transcriptFile}`, `--base-dir=${dir}`];
    assert.equal(runCli(args).status, 0);
    assert.equal(runCli(args).status, 0);

    const lessonDir = path.join(dir, 'knowledge', 'video-lessons');
    const generated = new Set(['README.md', 'backlog.md']);
    const lessons = fs.readdirSync(lessonDir).filter((file) => file.endsWith('.md') && !generated.has(file));
    assert.deepEqual(lessons, ['youtube-dQw4w9WgXcQ.md']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lessonDir, 'index.json'), 'utf8')).length, 1);
  });
});

test('a dry run reports what would happen and writes nothing', () => {
  withWorkspace(({ dir, transcriptFile }) => {
    const result = runCli([
      URL,
      `--transcript-file=${transcriptFile}`,
      `--base-dir=${dir}`,
      '--dry-run'
    ]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /DRY RUN/);
    assert.equal(fs.existsSync(path.join(dir, 'knowledge')), false, 'nothing on disk');
  });
});

test('--save-transcript is required to keep the raw transcript', () => {
  withWorkspace(({ dir, transcriptFile }) => {
    const base = [URL, `--transcript-file=${transcriptFile}`, `--base-dir=${dir}`];
    assert.equal(runCli(base).status, 0);
    const transcriptDir = path.join(dir, 'knowledge', 'video-lessons', 'transcripts');
    assert.equal(fs.existsSync(transcriptDir), false, 'third-party text is not committed by default');

    assert.equal(runCli([...base, '--save-transcript']).status, 0);
    assert.match(
      fs.readFileSync(path.join(transcriptDir, 'youtube-dQw4w9WgXcQ.txt'), 'utf8'),
      /biggest mistake/
    );
  });
});

test('an unsupported link is rejected without writing anything', () => {
  withWorkspace(({ dir }) => {
    const result = runCli(['https://vimeo.com/123456789', `--base-dir=${dir}`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a supported YouTube or Instagram video URL/);
    assert.equal(fs.existsSync(path.join(dir, 'knowledge')), false);
  });
});

test('an unknown flag fails loudly instead of being ignored', () => {
  const result = runCli([URL, '--publish-everywhere']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --publish-everywhere/);
});

test('--transcript-file is rejected when it cannot apply to exactly one video', () => {
  const result = runCli(['--inbox', '--transcript-file=/tmp/whatever.txt']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one URL/);
});

test('prints usage when invoked with no arguments', () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--transcript-file/);
});

test('reports a missing inbox file rather than silently doing nothing', () => {
  const result = runCli(['--inbox-file=/nonexistent/inbox.md']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /inbox file not found/);
});

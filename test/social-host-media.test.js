'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'host-media.js');
const REPO_ROOT = path.join(__dirname, '..');

function run(args, { expectFail = false } = {}) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    if (!expectFail) throw error;
    return { code: error.status || 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

test('ingests an image into the media store and prints the stable URL', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-media-'));
  const src = path.join(tmp, 'src.jpg');
  fs.writeFileSync(src, 'jpeg-bytes');
  const date = '2999-01-02';
  const id = `${date}-wellness-feed`;
  const dest = path.join(REPO_ROOT, 'content', 'media', date, `${id}.jpg`);
  try {
    const { code, out } = run([`--file=${src}`, `--date=${date}`, `--id=${id}`]);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(dest), 'image copied into content/media');
    assert.match(out, /raw\.githubusercontent\.com\/lionelite\/lion-elite-os\/automation\/social-content\/content\/media\/2999-01-02\/2999-01-02-wellness-feed\.jpg/);
  } finally {
    fs.rmSync(path.join(REPO_ROOT, 'content', 'media', date), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('requires --file and --id', () => {
  assert.equal(run(['--id=x'], { expectFail: true }).code, 1);
  assert.equal(run(['--file=/tmp/x.jpg'], { expectFail: true }).code, 1);
});

test('fails cleanly when the source file is missing', () => {
  const { code, out } = run(['--file=/nonexistent/nope.jpg', '--id=2999-01-02-wellness-feed'], { expectFail: true });
  assert.equal(code, 1);
  assert.match(out, /File not found/);
});

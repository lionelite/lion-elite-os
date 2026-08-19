'use strict';

// Guards the public front door of the coaching product.
//
// Two incidents motivate this file, both of which shipped to production and
// neither of which any existing test would have caught:
//
//   1. A temporary "preview" preload replaced the coach credential check with
//      a function that always returned true, and it was wired into `npm start`
//      — the Render start command. Anyone who found /coaching/ could sign in
//      as the coach.
//   2. The matching front-end left the sign-in form as display:none behind
//      "Opening preview…" copy, so after the server fix the owner could not
//      log in at all, and no visitor had any route to becoming a client.
//
// These are source-text assertions, in the same spirit as
// test/postgres-prospect-store-schema.test.js: the real failure could not be
// caught by exercising the code, so the code is checked as text instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the start command loads no preload shim', () => {
  const start = JSON.parse(read('package.json')).scripts.start;
  assert.equal(start, 'node start.js');
  assert.ok(!/-r\s|--require/.test(start), 'a preload is how the auth bypass reached production');
});

/** Every .js file that ships in the running web service. */
function serviceSources() {
  const files = ['server.js', 'start.js'];
  for (const dir of ['routes', 'lib/coaching']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (name.endsWith('.js')) files.push(path.posix.join(dir, name));
    }
  }
  return files;
}

// secureEquals gates both the coach token check and CSRF origin validation, so
// reassigning it anywhere disables both at once.
const REASSIGNS_SECURE_EQUALS = /secureEquals\s*=\s*(?!function\b)/;

test('the bypass detector actually detects the bypass', () => {
  // The exact line that shipped to production, so this guard cannot rot into a
  // regex that quietly matches nothing.
  assert.ok(REASSIGNS_SECURE_EQUALS.test('security.secureEquals = () => true;'));
  assert.ok(REASSIGNS_SECURE_EQUALS.test('security.secureEquals=()=>true'));
  // And it must not fire on the real declaration.
  assert.ok(!REASSIGNS_SECURE_EQUALS.test('function secureEquals(actual, expected) {'));
});

test('nothing in the service overwrites the credential comparison', () => {
  for (const file of serviceSources()) {
    const source = read(file).replace(/function\s+secureEquals/g, '');
    assert.ok(!REASSIGNS_SECURE_EQUALS.test(source), `${file} must not reassign secureEquals`);
  }
});

test('no preview-mode bypass file exists', () => {
  assert.equal(
    fs.existsSync(path.join(root, 'preview-open.js')),
    false,
    'preview-open.js disabled authentication in production'
  );
});

test('the coach sign-in form is visible and wired', () => {
  const html = read('public/coaching/index.html');
  const form = /<form id="coach-login-form"[^>]*>/.exec(html);

  assert.ok(form, 'the login form must exist');
  assert.ok(!/display\s*:\s*none/.test(form[0]), 'a hidden form locks the owner out of their own portal');
  assert.ok(!html.includes('Opening preview'), 'preview copy must not ship');
  assert.ok(!/preview mode/i.test(html), 'preview copy must not ship');
});

test('a visitor who is not a client has a route to buy', () => {
  const html = read('public/coaching/index.html');
  assert.ok(
    html.includes('href="/join/"'),
    'without this the sign-in screen is a dead end and the checkout is unreachable'
  );
});

test('the purchase page exists and posts to the checkout endpoint', () => {
  const html = read('public/join/index.html');
  assert.ok(html.includes('/api/checkout/session'), 'the buy button must reach checkout');
  assert.ok(/<button[^>]*id="start"/.test(html), 'there must be something to click');
});

'use strict';

// The unsubscribe path.
//
// Every consumer email already carries {{unsubscribe_url}} and campaign-emails.js
// refuses to build a consumer send without one — but no page existed to receive
// the click. A link that goes nowhere is not a working opt-out mechanism.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const token = require('../lib/leads/unsubscribe-token');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'unsubscribe', 'app.js'), 'utf8');

function withSecret(value, fn) {
  const previous = process.env.UNSUBSCRIBE_SECRET;
  if (value == null) delete process.env.UNSUBSCRIBE_SECRET;
  else process.env.UNSUBSCRIBE_SECRET = value;
  try { return fn(); } finally {
    if (previous == null) delete process.env.UNSUBSCRIBE_SECRET;
    else process.env.UNSUBSCRIBE_SECRET = previous;
  }
}

test('a signed link verifies and a tampered one does not', () => {
  withSecret('a-secret', () => {
    const signature = token.sign('Person@Example.com');
    assert.ok(signature);
    assert.equal(token.verify('person@example.com', signature), 'signed');
    assert.equal(token.verify('person@example.com', 'x'.repeat(signature.length)), 'invalid');
    // Signing is case- and whitespace-insensitive on the address.
    assert.equal(token.verify('  PERSON@EXAMPLE.COM ', signature), 'signed');
  });
});

test('a different address does not validate against another signature', () => {
  withSecret('a-secret', () => {
    const signature = token.sign('one@example.com');
    assert.notEqual(token.verify('two@example.com', signature), 'signed');
  });
});

test('unsubscribe still works with no secret configured', () => {
  // Failing closed here would break the opt-out the law requires.
  withSecret(null, () => {
    assert.equal(token.sign('person@example.com'), '');
    assert.equal(token.verify('person@example.com', ''), 'unsigned');
    assert.equal(token.verify('person@example.com', 'anything'), 'unsigned');
    const url = token.unsubscribeUrl('person@example.com', 'https://example.com');
    assert.ok(url.includes('email=person%40example.com'));
    assert.ok(!url.includes('&t='), 'no signature when no secret exists');
  });
});

test('the emailed link carries the address and its signature', () => {
  withSecret('a-secret', () => {
    const url = new URL(token.unsubscribeUrl('person@example.com', 'https://example.com/'));
    assert.equal(url.pathname, '/unsubscribe/');
    assert.equal(url.searchParams.get('email'), 'person@example.com');
    assert.equal(token.verify(url.searchParams.get('email'), url.searchParams.get('t')), 'signed');
  });
});

test('the page does not unsubscribe on load', () => {
  // Mail clients and security scanners prefetch links. A page that fires on
  // load unsubscribes people who never clicked anything.
  assert.ok(script.includes("addEventListener('submit'"), 'the opt-out runs on submit');
  assert.ok(
    !/addEventListener\(\s*['"](DOMContentLoaded|load)['"]/.test(script),
    'nothing may trigger the opt-out from page load'
  );
  const submitCalls = script.match(/\.submit\(\)/g) || [];
  assert.deepEqual(submitCalls, [], 'the form must not submit itself');
});

test('the page confirms nothing about who is on the list', () => {
  // The response is identical whether or not the address was found, so the
  // page cannot be used to test whether we hold someone.
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'leads.js'), 'utf8');
  assert.ok(route.includes('unsubscribed: true'), 'the answer is always the same');
  assert.ok(!/not found|no such|unknown address/i.test(route), 'no negative disclosure');
});

test('an invalid signature is honoured rather than refused', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'leads.js'), 'utf8');
  const handler = route.slice(route.indexOf("router.post('/unsubscribe'"));
  const body = handler.slice(0, handler.indexOf('router.use'));
  assert.ok(body.includes('store.unsubscribe'), 'the opt-out always runs');
  assert.ok(
    !/if\s*\(\s*trust\s*===\s*'invalid'\s*\)\s*{[^}]*throw/.test(body),
    'a bad signature must not block the opt-out'
  );
});

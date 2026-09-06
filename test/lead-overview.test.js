'use strict';

// The lead overview.
//
// Three engines write leads and none had a surface, so "what leads do we have"
// meant a SQL prompt — which is a large part of why nobody noticed all three
// were inert. These cover the shaping; the queries themselves are exercised
// against a real database, since CI has no Postgres.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SOURCES } = require('../lib/leads/lead-overview');

const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'coaching.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'coaching', 'app.js'), 'utf8');
const overview = fs.readFileSync(path.join(__dirname, '..', 'lib', 'leads', 'lead-overview.js'), 'utf8');

test('every lead-writing campaign appears in the overview', () => {
  // A source that writes leads nobody can see is the failure this fixes, so the
  // ids here must stay in step with what actually writes.
  const store = fs.readFileSync(path.join(__dirname, '..', 'social-listening', 'src', 'universal-lead-store.js'), 'utf8');
  const discovery = fs.readFileSync(path.join(__dirname, '..', 'lib', 'discovery', 'discovery-run.js'), 'utf8');
  for (const id of ['bluesky-universal-leads', 'bluesky-audience-leads']) {
    assert.ok(store.includes(id), `${id} must still be written by the listener`);
    assert.ok(SOURCES[id], `${id} must be shown in the overview`);
  }
  assert.ok(discovery.includes('osm-business-discovery'));
  assert.ok(SOURCES['osm-business-discovery']);
});

test('the lead list is owner-only', () => {
  // It is the whole prospect and opt-in list; an individual coach has no reason
  // to see it, and the roster scoping elsewhere would be pointless if they did.
  const line = routes.split('\n').find(l => l.includes("router.get('/admin/leads'"));
  assert.ok(line, 'the route must exist');
  assert.ok(line.includes('requireCoach'), 'must require a coach session');
  assert.ok(line.includes('requireOwner'), 'must require the owner role');
});

test('the Leads tab is not offered to a non-owner', () => {
  const ownerNav = app.split('\n').find(l => l.includes('const ownerNav'));
  assert.ok(ownerNav.includes('coach-leads'), 'owners get the tab');
  const coachNav = app.slice(app.indexOf('const coachNav'), app.indexOf('const ownerNav'));
  assert.ok(!coachNav.includes('coach-leads'), 'a plain coach does not');
});

test('the overview answers whether leads are arriving, not just how many exist', () => {
  // A total says what was once collected. Only a recent count says the engines
  // are alive, which is the actual question.
  assert.ok(overview.includes("interval '24 hours'"), 'must compute a 24h rate');
  assert.ok(overview.includes("interval '7 days'"), 'must compute a 7d rate');
  assert.ok(overview.includes('flowing:'), 'must state it plainly');
});

test('the request limit is bounded', () => {
  const line = routes.split('\n').find(l => l.includes('Math.min(100'));
  assert.ok(line, 'an unbounded limit lets a caller ask for the entire table');
});

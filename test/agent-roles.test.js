const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const roles = require('../lib/agents/roles');
const { ALLOWED_QUEUE_ACTIONS, BLOCKED_ACTIONS } = require('../lib/action-catalog');

test('the registry validates against the dispatcher allowlist', () => {
  const result = roles.validateRegistry();
  assert.equal(result.valid, true, result.problems.join('; '));
});

test('every role declares only dispatchable actions', () => {
  for (const r of roles.ROLES) {
    for (const action of r.actions) {
      assert.ok(ALLOWED_QUEUE_ACTIONS[action], `${r.id} declares un-allowlisted "${action}"`);
      assert.ok(!BLOCKED_ACTIONS.has(action), `${r.id} declares blocked "${action}"`);
    }
  }
});

test('no role can request a blocked action, whatever the registry says', () => {
  for (const blocked of BLOCKED_ACTIONS) {
    for (const r of roles.ROLES) {
      assert.ok(!r.actions.includes(blocked), `${r.id} must not be able to ${blocked}`);
    }
  }
});

test('every role owns a decision, a KPI and an evidence base', () => {
  for (const r of roles.ROLES) {
    assert.ok(r.ownsDecision && r.ownsDecision.length > 5, `${r.id} owns no decision`);
    assert.ok(r.kpis.length > 0, `${r.id} has no KPI`);
    assert.ok(r.knowledgeDomains.length > 0, `${r.id} has no knowledge domain`);
    assert.ok(r.mandate.length > 20, `${r.id} has no usable mandate`);
  }
});

test('exactly one role coordinates, and everyone else reports to it', () => {
  const coordinators = roles.ROLES.filter((r) => r.reportsTo === null);
  assert.equal(coordinators.length, 1);
  assert.equal(coordinators[0].id, 'executive');
  for (const r of roles.ROLES.filter((x) => x.reportsTo !== null)) {
    assert.ok(roles.role(r.reportsTo), `${r.id} reports to a role that does not exist`);
  }
});

test('the compliance role has a veto and no revenue KPI', () => {
  const compliance = roles.role('research-compliance');
  assert.equal(compliance.hasVeto, true);
  // A revenue target would put it in conflict with the thing it enforces.
  for (const kpi of compliance.kpis) {
    assert.ok(!/revenue/i.test(kpi), `compliance must not carry a revenue KPI (${kpi})`);
  }
});

test('every outward-facing role names the control that gates it', () => {
  for (const id of ['sales', 'client-success', 'marketing']) {
    const r = roles.role(id);
    assert.ok(r.gates.length > 0, `${id} does outward-facing work and must name its gate`);
    for (const gate of r.gates) assert.ok(roles.CONTROLS[gate], `unknown control ${gate}`);
  }
});

test('the four intraday checkpoints each establish something and name an action', () => {
  assert.deepEqual(roles.CHECKPOINTS.map((c) => c.id), ['morning', 'midday', 'afternoon', 'evening']);
  for (const c of roles.CHECKPOINTS) {
    assert.ok(c.establishes.length > 20, `${c.id} establishes nothing`);
    assert.ok(ALLOWED_QUEUE_ACTIONS[c.action], `${c.id} names un-dispatchable "${c.action}"`);
  }
});

test('the daily target defaults to the figures in Issue #73', () => {
  assert.equal(roles.DAILY_REVENUE_TARGET, 3500);
  assert.equal(roles.DAILY_REVENUE_STRETCH, 5000);
});

test('unknown roles resolve to null rather than throwing', () => {
  assert.equal(roles.role('nope'), null);
});

// Source-text reconciliation. server.js cannot be required here (it needs
// express/pg, which CI installs but this check should not depend on), so the
// roster is compared against the source the same way
// test/postgres-prospect-store-schema.test.js compares SQL it cannot execute.
test('server.js roster matches the registry exactly — the drift CLAUDE.md warns about', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const arrayStart = source.indexOf('const agents = [');
  assert.ok(arrayStart > -1, 'server.js must still define an agents array');
  const arrayEnd = source.indexOf('\n];', arrayStart);
  const block = source.slice(arrayStart, arrayEnd);
  const ids = [...block.matchAll(/^\s+id: '([a-z-]+)'/gm)].map((m) => m[1]);

  assert.deepEqual([...ids].sort(), [...roles.roleIds()].sort(),
    'server.js roster and lib/agents/roles.js disagree — update the registry, not just one of them');
});

test('server.js reads the registry rather than redescribing it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /require\('\.\/lib\/agents\/roles'\)/, 'server.js must import the registry');
  assert.match(source, /validateRegistry\(\)/, 'server.js must validate the registry at startup');
});

test('every knowledge domain a role declares actually exists', () => {
  const root = path.join(__dirname, '..');
  for (const r of roles.ROLES) {
    for (const domain of r.knowledgeDomains) {
      assert.ok(fs.existsSync(path.join(root, domain)),
        `${r.id} points at "${domain}", which does not exist — the agent would be less grounded than it claims`);
    }
  }
});

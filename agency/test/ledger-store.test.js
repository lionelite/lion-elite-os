const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/ledger-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agency-store-'));
}

test('a ref with a path separator or traversal is rejected', () => {
  for (const bad of ['../escape', 'a/b', 'a\\b', '..', '', '  ', 'has space', 'x'.repeat(65), 'end-']) {
    assert.throws(() => store.safeRef(bad), /Invalid client ref/, `"${bad}" must be rejected`);
  }
});

test('a valid ref is normalised to lower case', () => {
  assert.equal(store.safeRef('Cedar-Roofing'), 'cedar-roofing');
  assert.equal(store.safeRef('acme2'), 'acme2');
});

test('paths stay inside the store directory', () => {
  const dir = tmpDir();
  const p = store.ledgerPath('cedar-roofing', { dir });
  assert.equal(path.dirname(p), dir);
  assert.equal(path.basename(p), 'cedar-roofing.json');
});

test('a ledger round-trips through disk unchanged', () => {
  const dir = tmpDir();
  const ledger = { clientRef: 'acme', clientName: 'Acme', state: 'qualified', receipts: [{ amount: 100 }] };
  store.saveLedger(ledger, { dir });
  assert.deepEqual(store.loadLedger('acme', { dir }), ledger);
});

test('a missing ledger loads as null rather than throwing', () => {
  assert.equal(store.loadLedger('nobody', { dir: tmpDir() }), null);
});

test('a missing client file throws with the path named', () => {
  const dir = tmpDir();
  assert.throws(() => store.loadClient('nobody', { dir }), /No client file for "nobody"/);
});

test('a client round-trips and is keyed by its ref', () => {
  const dir = tmpDir();
  store.saveClient({ ref: 'acme', name: 'Acme', monthlyInboundLeads: 70 }, { dir });
  assert.ok(fs.existsSync(path.join(dir, 'acme.json')));
  assert.equal(store.loadClient('acme', { dir }).name, 'Acme');
});

test('saving requires the identifying field', () => {
  const dir = tmpDir();
  assert.throws(() => store.saveLedger({}, { dir }), TypeError);
  assert.throws(() => store.saveClient({}, { dir }), TypeError);
});

test('no temp file is left behind after a write', () => {
  const dir = tmpDir();
  store.saveLedger({ clientRef: 'acme', state: 'qualified' }, { dir });
  assert.deepEqual(fs.readdirSync(dir), ['acme.json']);
});

test('a write replaces the previous version rather than appending', () => {
  const dir = tmpDir();
  store.saveLedger({ clientRef: 'acme', state: 'qualified' }, { dir });
  store.saveLedger({ clientRef: 'acme', state: 'won' }, { dir });
  assert.equal(store.loadLedger('acme', { dir }).state, 'won');
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('listing returns every ledger, oldest first', () => {
  const dir = tmpDir();
  store.saveLedger({ clientRef: 'b', openedAt: '2026-02-01T00:00:00Z' }, { dir });
  store.saveLedger({ clientRef: 'a', openedAt: '2026-01-01T00:00:00Z' }, { dir });
  assert.deepEqual(store.listLedgers({ dir }).map((l) => l.clientRef), ['a', 'b']);
});

test('listing an absent directory is empty, not an error', () => {
  const dir = path.join(tmpDir(), 'does-not-exist');
  assert.deepEqual(store.listLedgers({ dir }), []);
  assert.deepEqual(store.listClients({ dir }), []);
});

test('client and ledger data are gitignored — they hold financials and contractors get repo access', () => {
  const gitignore = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
  assert.match(gitignore, /^agency\/clients\/$/m);
  assert.match(gitignore, /^agency\/ledgers\/$/m);
});

test('every example client file is named after its own ref', () => {
  const dir = path.join(__dirname, '..', 'examples');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const client = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(file, `${client.ref}.json`, `${file} must be named ${client.ref}.json so loadClient(ref) finds it`);
  }
});

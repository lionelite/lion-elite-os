'use strict';

// Persistence for engagement ledgers and client discovery files.
//
// LOCAL JSON ON PURPOSE, AND IT MUST STAY UNCOMMITTED.
//
// Client files hold a business's revenue, lead volume, close rate and customer
// value. Ledgers hold what we charged them and what we paid contractors. Neither
// belongs in git, and the reason is specific rather than general caution:
// `access.js` grants contractors `repo-branch` access by design. Committing this
// data would route every client's financials straight through the access tier
// built to keep contractors away from exactly that. `.gitignore` covers both
// directories; keep it that way.
//
// Not Postgres. This module deliberately does not touch `lib/database.js` — the
// agency engine has no service, no pool and no migration, and claiming otherwise
// is the aspirational-docs trap CLAUDE.md warns about. If this ever needs
// multi-user concurrent access, that is a real migration, not a config change.

const fs = require('node:fs');
const path = require('node:path');

const { normalize } = require('./ledger');

const ROOT = path.join(__dirname, '..');
const CLIENTS_DIR = path.join(ROOT, 'clients');
const LEDGERS_DIR = path.join(ROOT, 'ledgers');
// The bench holds contractor names, capacity and agreement status — personal and
// commercial data, gitignored for the same reason as the rest.
const BENCH_FILE = path.join(ROOT, 'bench', 'roster.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeRef(ref) {
  const value = String(ref || '').trim();
  // Refs become filenames. A ref containing a path separator or traversal would
  // write outside the store, so it is rejected rather than sanitised — a silent
  // rename makes the next lookup fail confusingly.
  // Must start and end alphanumeric. A trailing hyphen is filesystem-safe but
  // lets "acme" and "acme-" coexist as two near-identical ledgers, which is a
  // footgun for whoever types the ref next.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i.test(value)) {
    throw new Error(`Invalid client ref "${ref}". Use letters, digits and internal hyphens only, starting and ending alphanumeric (max 64 characters).`);
  }
  return value.toLowerCase();
}

function clientPath(ref, { dir = CLIENTS_DIR } = {}) {
  return path.join(dir, `${safeRef(ref)}.json`);
}

function ledgerPath(ref, { dir = LEDGERS_DIR } = {}) {
  return path.join(dir, `${safeRef(ref)}.json`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  // Write-then-rename so an interrupted write cannot leave a truncated ledger
  // where a valid one used to be.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function loadClient(ref, options = {}) {
  const file = clientPath(ref, options);
  if (!fs.existsSync(file)) throw new Error(`No client file for "${ref}" at ${file}.`);
  return readJson(file);
}

function saveClient(client, options = {}) {
  if (!client || !client.ref) throw new TypeError('client.ref is required.');
  return writeJson(clientPath(client.ref, options), client);
}

function loadLedger(ref, options = {}) {
  const file = ledgerPath(ref, options);
  if (!fs.existsSync(file)) return null;
  // Normalised on the way in so a ledger written by an older version of the
  // schema is usable immediately, rather than throwing on the first field it
  // predates.
  return normalize(readJson(file));
}

function saveLedger(ledger, options = {}) {
  if (!ledger || !ledger.clientRef) throw new TypeError('ledger.clientRef is required.');
  return writeJson(ledgerPath(ledger.clientRef, options), ledger);
}

function listLedgers({ dir = LEDGERS_DIR } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => normalize(readJson(path.join(dir, f))))
    .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)));
}

function loadBench({ file = BENCH_FILE } = {}) {
  if (!fs.existsSync(file)) return { contractors: [] };
  return readJson(file);
}

function saveBench(bench, { file = BENCH_FILE } = {}) {
  if (!bench || !Array.isArray(bench.contractors)) throw new TypeError('A bench with a contractors array is required.');
  return writeJson(file, bench);
}

function listClients({ dir = CLIENTS_DIR } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)));
}

module.exports = {
  CLIENTS_DIR,
  LEDGERS_DIR,
  BENCH_FILE,
  safeRef,
  clientPath,
  ledgerPath,
  loadClient,
  saveClient,
  loadLedger,
  saveLedger,
  listLedgers,
  listClients,
  loadBench,
  saveBench,
};

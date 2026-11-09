#!/usr/bin/env node
'use strict';

// Add addresses or domains to the B2B opt-out list (outreach_suppressions).
//
//   npm run outreach:suppress -- --email someone@clinic.com --reason opt_out
//   npm run outreach:suppress -- --domain clinic.com --reason complaint
//   npm run outreach:suppress -- --csv contacted.csv --reason prior_contact
//
// --csv reads every e-mail address found anywhere in the file, so an export of
// the Drive master sheet or a Gmail sent-folder export works as-is. Use
// `prior_contact` for clinics already approached by hand, so the automated
// pipeline never cold-emails them a second, different introduction.
// Requires DATABASE_URL. Idempotent.

const fs = require('fs');
const { PostgresProspectStore } = require('../lib/postgres-prospect-store');
const { close } = require('../lib/database');

const REASONS = ['opt_out', 'bounce', 'complaint', 'prior_contact', 'manual'];

function parse(argv) {
  const args = { emails: [], domains: [], reason: null, note: '' };
  for (let i = 2; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--email') { args.emails.push(value); i++; }
    else if (flag === '--domain') { args.domains.push(value); i++; }
    else if (flag === '--csv') {
      const found = fs.readFileSync(value, 'utf8').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [];
      args.emails.push(...found); i++;
    }
    else if (flag === '--reason') { args.reason = value; i++; }
    else if (flag === '--note') { args.note = value; i++; }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!REASONS.includes(args.reason)) throw new Error(`--reason must be one of ${REASONS.join(', ')}`);
  if (!args.emails.length && !args.domains.length) throw new Error('Give --email, --domain or --csv.');
  return args;
}

(async () => {
  const args = parse(process.argv);
  const store = new PostgresProspectStore();
  let added = 0;
  const emails = [...new Set(args.emails.map(e => e.toLowerCase()))];
  for (const address of emails) if ((await store.suppress({ address, reason: args.reason, source: 'cli', note: args.note }, 'cli')).added) added++;
  for (const domain of args.domains) if ((await store.suppress({ domain, reason: args.reason, source: 'cli', note: args.note }, 'cli')).added) added++;
  console.log(`[suppress] ${added} new entr${added === 1 ? 'y' : 'ies'} (${emails.length + args.domains.length} given; the rest were already listed). Reason: ${args.reason}.`);
})()
  .catch(error => { console.error(`[suppress] ${error.message}`); process.exitCode = 1; })
  .finally(() => close().catch(() => {}));

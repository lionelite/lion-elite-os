'use strict';

/**
 * Reads the gated-access leads captured by the Wellness storefront.
 *
 * The storefront (peptide-science-animations-store) writes `member_leads` to a
 * libSQL/Turso database from its CustomerAccessGate. This is the read side, so
 * LionOS can act on those leads without reaching into the storefront app.
 *
 * Read-only by design: this module never writes to the storefront's table.
 * Contact state belongs in LionOS, so an outreach bug can never corrupt the
 * signup record itself.
 */

const ENV_URL_KEYS = ['MEMBER_LEADS_DATABASE_URL', 'TURSO_DATABASE_URL', 'LIBSQL_DATABASE_URL'];
const ENV_TOKEN_KEYS = ['MEMBER_LEADS_AUTH_TOKEN', 'TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN'];

const firstSet = (keys) => {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return { key, value };
  }
  return null;
};

function getConfig() {
  const url = firstSet(ENV_URL_KEYS);
  if (!url) return null;
  const token = firstSet(ENV_TOKEN_KEYS);
  return { url: url.value, authToken: token ? token.value : undefined, urlEnvKey: url.key };
}

const SELECT = `
  SELECT id, name, email, phone,
         email_marketing_consent, sms_marketing_consent,
         email_consent_at, sms_consent_at,
         source, status, created_at, updated_at
  FROM member_leads
  ORDER BY created_at DESC
  LIMIT ?`;

/**
 * Fetch raw lead rows. Throws a directive error rather than returning [] when
 * the database is not configured: an empty list would read as "nobody signed
 * up", which is the opposite of the truth and exactly the wrong conclusion.
 */
async function fetchMemberLeads({ limit = 5000 } = {}) {
  const config = getConfig();
  if (!config) {
    throw new Error(
      `Member lead database is not configured. Set one of ${ENV_URL_KEYS.join(', ')} ` +
        '(plus an auth token if the database requires one). Refusing to report zero leads, ' +
        'which would look like no signups rather than no connection.'
    );
  }

  let createClient;
  try {
    ({ createClient } = require('@libsql/client'));
  } catch {
    throw new Error(
      'The @libsql/client package is required to read member_leads. Install it with ' +
        '`npm install @libsql/client`, or run with --sample to see the report without a database.'
    );
  }

  const db = createClient({ url: config.url, authToken: config.authToken });
  const result = await db.execute({ sql: SELECT, args: [limit] });
  return result.rows.map((row) => ({ ...row }));
}

/** True when a live read is possible; lets callers degrade instead of throwing. */
const isConfigured = () => getConfig() !== null;

module.exports = { fetchMemberLeads, isConfigured, ENV_URL_KEYS, ENV_TOKEN_KEYS };

'use strict';

/**
 * Serialize Postgres integration test files. `node --test` runs files in
 * parallel processes against the same CI database; one file re-running the
 * schema (ALTER/CREATE INDEX) or TRUNCATE while another holds an open
 * transaction deadlocks. Each integration test holds this session-level
 * advisory lock for its whole run.
 *
 * Lives in test/helpers/ (not matched by test/*.test.js).
 */
const INTEGRATION_LOCK_KEY = 727_002;

async function holdExclusiveDb() {
  const { pool } = require('../../lib/database');
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [INTEGRATION_LOCK_KEY]);
  return async function release() {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [INTEGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  };
}

module.exports = { holdExclusiveDb };

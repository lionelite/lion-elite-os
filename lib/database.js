'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = connectionString ? new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
}) : null;

function requirePool() {
  if (!pool) {
    const error = new Error('DATABASE_URL is required for PostgreSQL mode.');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
  return pool;
}

async function query(text, params = []) {
  return requirePool().query(text, params);
}

async function withTransaction(work) {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  // Serialize concurrent migrations. `CREATE ... IF NOT EXISTS` is not safe under
  // concurrency — two sessions racing on a fresh database both pass the existence
  // check and one dies on a unique-index violation in the catalog. That happens
  // whenever two processes migrate at once: parallel `node --test` files in CI, or
  // several Render services starting together after a deploy.
  const client = await requirePool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(schema);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// Arbitrary constant; only has to be stable and not collide with other locks.
const MIGRATION_LOCK_KEY = 727_001;

async function healthcheck() {
  const started = Date.now();
  const result = await query('SELECT now() AS database_time');
  return { ok: true, latencyMs: Date.now() - started, databaseTime: result.rows[0].database_time };
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { pool, query, withTransaction, migrate, healthcheck, close };

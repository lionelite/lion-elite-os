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
  await query(schema);
}

async function healthcheck() {
  const started = Date.now();
  const result = await query('SELECT now() AS database_time');
  return { ok: true, latencyMs: Date.now() - started, databaseTime: result.rows[0].database_time };
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { pool, query, withTransaction, migrate, healthcheck, close };

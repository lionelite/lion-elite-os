'use strict';

const IORedis = require('ioredis');
const crypto = require('crypto');

const redisUrl = process.env.REDIS_URL;

function createRedisConnection(overrides = {}) {
  if (!redisUrl) {
    const error = new Error('REDIS_URL is required for Redis mode.');
    error.code = 'REDIS_NOT_CONFIGURED';
    throw error;
  }

  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 10000),
    ...overrides
  });
}

let sharedClient;
function getRedis() {
  if (!sharedClient) sharedClient = createRedisConnection();
  return sharedClient;
}

async function ensureConnected(client = getRedis()) {
  if (client.status === 'wait') await client.connect();
  return client;
}

async function healthcheck() {
  const started = Date.now();
  const client = await ensureConnected();
  const response = await client.ping();
  return { ok: response === 'PONG', latencyMs: Date.now() - started, status: client.status };
}

async function cacheGet(key) {
  const value = await (await ensureConnected()).get(`cache:${key}`);
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return value; }
}

async function cacheSet(key, value, ttlSeconds = 3600) {
  await (await ensureConnected()).set(`cache:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
  return value;
}

async function withLock(key, work, ttlMs = 30000) {
  const client = await ensureConnected();
  const lockKey = `lock:${key}`;
  const token = crypto.randomUUID();
  const acquired = await client.set(lockKey, token, 'PX', ttlMs, 'NX');
  if (!acquired) {
    const error = new Error(`Lock is already held: ${key}`);
    error.code = 'LOCK_NOT_ACQUIRED';
    throw error;
  }

  try {
    return await work();
  } finally {
    await client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      token
    );
  }
}

async function closeRedis() {
  if (sharedClient) {
    await sharedClient.quit();
    sharedClient = null;
  }
}

module.exports = {
  createRedisConnection,
  getRedis,
  ensureConnected,
  healthcheck,
  cacheGet,
  cacheSet,
  withLock,
  closeRedis
};

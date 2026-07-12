'use strict';

const os = require('os');
const startedAt = Date.now();

function log(level, event, data = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: process.env.RENDER_SERVICE_NAME || process.env.SERVICE_NAME || 'lion-elite-os',
    environment: process.env.NODE_ENV || 'development',
    instance: process.env.RENDER_INSTANCE_ID || os.hostname(),
    ...data
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function runtimeMetrics(extra = {}) {
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
    nodeVersion: process.version,
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external
    },
    ...extra
  };
}

function requestLogger(req, res, next) {
  const started = Date.now();
  const requestId = req.get('x-request-id') || cryptoRandomId();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.on('finish', () => log('info', 'http.request', {
    requestId,
    method: req.method,
    path: req.originalUrl,
    status: res.statusCode,
    durationMs: Date.now() - started
  }));
  next();
}

function cryptoRandomId() {
  return require('crypto').randomUUID();
}

module.exports = { log, runtimeMetrics, requestLogger };

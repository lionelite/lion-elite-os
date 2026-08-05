'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// Stub the Postgres-backed digest so the route renders without a database.
const origRequire = Module.prototype.require;
Module.prototype.require = function patched(id) {
  if (id === './lib/leads-digest') {
    return {
      buildLeadsDigest: async () => ({
        generatedAt: 'test',
        prospects: { total: 2, topRated: [{ name: 'Route Co', score: 90, stage: 'qualified', campaign_id: 'c', created: 'd' }] },
        outreach: {}
      })
    };
  }
  return origRequire.apply(this, arguments);
};

process.env.EXECUTIVE_API_TOKEN = 'route-secret';
process.env.PORT = '0';
// Keep the narrow stub installed for the file's lifetime: the /leads route
// require()s ./lib/leads-digest lazily at request time, so restoring here
// would defeat it. The patch only intercepts that one module id.
const { app } = require(path.join(__dirname, '..', 'executive-orchestrator.js'));

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function get(server, urlPath) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, body: await res.text() };
}

test('leads dashboard is token-gated and renders HTML with the right token', async () => {
  const server = await listen();
  try {
    const noToken = await get(server, '/leads');
    assert.equal(noToken.status, 401);

    const badToken = await get(server, '/leads?token=wrong');
    assert.equal(badToken.status, 401);

    const ok = await get(server, '/leads?token=route-secret');
    assert.equal(ok.status, 200);
    assert.match(ok.body, /Leads Dashboard/);
    assert.match(ok.body, /Route Co/);
  } finally {
    server.close();
  }
});

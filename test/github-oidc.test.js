'use strict';

// GitHub Actions OIDC verification for the outreach cron routes, and the
// route's auth gate: a valid token from the allowed workflow on main gets in;
// every other repo/branch/event/workflow/audience/expiry/signature/alg is 401,
// and with no credential at all the routes are never open.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { createGithubOidcVerifier, JWKS_URL } = require('../lib/outreach/github-oidc');
const { createClinicOutreachCronRouter } = require('../routes/clinic-outreach-cron');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const NOW = 1_800_000_000_000;
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims = {}, { header = {}, key = privateKey } = {}) {
  const h = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header });
  const t = Math.floor(NOW / 1000);
  const c = b64({
    iss: 'https://token.actions.githubusercontent.com', aud: 'lion-elite-os-cron',
    iat: t - 10, nbf: t - 10, exp: t + 300,
    repository: 'lionelite/lion-elite-os', ref: 'refs/heads/main', event_name: 'schedule',
    job_workflow_ref: 'lionelite/lion-elite-os/.github/workflows/daily-clinic-outreach.yml@refs/heads/main',
    actor: 'owner', run_id: '42',
    ...claims,
  });
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${c}`), key).toString('base64url');
  return `${h}.${c}.${s}`;
}

function verifier(env = {}) {
  let fetches = 0;
  const v = createGithubOidcVerifier({
    env, now: () => NOW,
    fetchImpl: async url => { fetches += 1; assert.equal(url, JWKS_URL); return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) }; },
  });
  return { v, fetches: () => fetches };
}

test('accepts a token from the allowed workflow on main, caching GitHub keys', async () => {
  const { v, fetches } = verifier();
  const caller = await v.verify(sign());
  assert.equal(caller.workflow, 'daily-clinic-outreach.yml');
  assert.equal(caller.event, 'schedule');
  await v.verify(sign({ event_name: 'workflow_dispatch', job_workflow_ref: 'lionelite/lion-elite-os/.github/workflows/outreach-control.yml@refs/heads/main' }));
  assert.equal(fetches(), 1, 'JWKS fetched once and cached');
});

test('rejects every claim that does not match', async () => {
  const { v } = verifier();
  const cases = {
    'other repo': sign({ repository: 'someone/fork' }),
    'other branch': sign({ ref: 'refs/heads/feature', job_workflow_ref: 'lionelite/lion-elite-os/.github/workflows/daily-clinic-outreach.yml@refs/heads/feature' }),
    'pull_request event': sign({ event_name: 'pull_request' }),
    'other workflow': sign({ job_workflow_ref: 'lionelite/lion-elite-os/.github/workflows/ci-render.yml@refs/heads/main' }),
    'wrong audience': sign({ aud: 'something-else' }),
    'wrong issuer': sign({ iss: 'https://evil.example' }),
    expired: sign({ exp: Math.floor(NOW / 1000) - 3600 }),
    'not yet valid': sign({ nbf: Math.floor(NOW / 1000) + 3600 }),
    'signed by another key': sign({}, { key: other.privateKey }),
    'unknown kid': sign({}, { header: { kid: 'nope' } }),
    'alg none': `${b64({ alg: 'none', kid: 'k1' })}.${b64({})}.`,
    'alg HS256': sign({}, { header: { alg: 'HS256' } }),
    garbage: 'not-a-jwt',
  };
  for (const [name, token] of Object.entries(cases)) {
    await assert.rejects(v.verify(token), `${name} must be rejected`);
  }
});

test('repository and audience follow env overrides', async () => {
  const { v } = verifier({ GITHUB_OIDC_REPOSITORY: 'acme/app', OIDC_AUDIENCE: 'x' });
  await assert.rejects(v.verify(sign()));
  await v.verify(sign({ repository: 'acme/app', aud: 'x', job_workflow_ref: 'acme/app/.github/workflows/daily-clinic-outreach.yml@refs/heads/main' }));
});

async function withServer(router, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/cron', router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('route: OIDC or secret gets in; nothing else does, and no config is open', async () => {
  const runs = [];
  const runner = { run: async opts => { runs.push(opts); return { status: 'completed', ...opts }; }, recordInbound: async x => x };
  const { v } = verifier();
  for (const env of [{}, { CRON_SECRET: 's3cret' }]) {
    await withServer(createClinicOutreachCronRouter({ runner, env, oidcVerifier: v, heartbeatMs: 10 }), async base => {
      const post = (headers = {}) => fetch(`${base}/api/cron/clinic-outreach?dryRun=1`, { method: 'POST', headers });
      assert.equal((await post()).status, 401, 'no credential');
      assert.equal((await post({ 'x-cron-secret': '' })).status, 401, 'empty secret never matches');
      assert.equal((await post({ authorization: `Bearer ${sign({ ref: 'refs/heads/x' })}` })).status, 401, 'bad token');
      const ok = await post({ authorization: `Bearer ${sign()}` });
      assert.equal(ok.status, 200);
      const body = JSON.parse(await ok.text());
      assert.equal(body.status, 'completed');
      assert.equal(body.trigger, 'github/daily-clinic-outreach.yml/schedule');
      assert.equal(body.dryRun, true);
      const bySecret = await post({ 'x-cron-secret': 's3cret' });
      assert.equal(bySecret.status, env.CRON_SECRET ? 200 : 401, 'secret path only when configured');
      await bySecret.text();
    });
  }
});

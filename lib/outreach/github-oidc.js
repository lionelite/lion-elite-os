'use strict';

/**
 * Verify a GitHub Actions OIDC token, so the scheduled outreach workflow can
 * prove who it is to the Render service without any shared secret.
 *
 * A workflow with `permissions: id-token: write` can ask GitHub for a
 * short-lived (about 5 minutes) RS256 JWT signed by GitHub. The claims name the
 * repository, the branch and the exact workflow file that ran. The service
 * accepts the token only if ALL of these hold:
 *
 *   - signature verifies against GitHub's published keys (JWKS), alg RS256
 *   - iss  = https://token.actions.githubusercontent.com
 *   - aud  = OIDC_AUDIENCE (default "lion-elite-os-cron")
 *   - exp/nbf/iat valid (60 s clock skew allowed)
 *   - repository = GITHUB_OIDC_REPOSITORY (default lionelite/lion-elite-os)
 *   - ref = refs/heads/main            (a branch or fork cannot trigger sends)
 *   - event_name is schedule or workflow_dispatch (not pull_request)
 *   - job_workflow_ref is one of the allowed workflow files on main
 *
 * Why this is at least as strong as the shared CRON_SECRET it complements:
 * there is no long-lived value to leak or rotate, a token is useless five
 * minutes after issue, and it is bound to one repo, one branch and named
 * workflow files. Anyone able to change workflows on main could already read a
 * repo secret, so the trust boundary is the same: write access to main, which
 * is branch-protected.
 */

const crypto = require('crypto');

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const DEFAULT_AUDIENCE = 'lion-elite-os-cron';
const DEFAULT_REPOSITORY = 'lionelite/lion-elite-os';
const ALLOWED_WORKFLOWS = Object.freeze(['daily-clinic-outreach.yml', 'outreach-control.yml']);
const ALLOWED_EVENTS = Object.freeze(['schedule', 'workflow_dispatch']);
const SKEW_S = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;

const fail = (code, message) => Object.assign(new Error(message), { code });

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw fail('OIDC_MALFORMED', 'token is not a JWT');
  }
}

function createGithubOidcVerifier({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let cache = { at: 0, keys: [] };

  async function keys(force = false) {
    if (!force && cache.keys.length && now() - cache.at < JWKS_TTL_MS) return cache.keys;
    const response = await fetchImpl(JWKS_URL);
    if (!response.ok) throw fail('OIDC_JWKS_UNAVAILABLE', `GitHub JWKS returned HTTP ${response.status}`);
    const body = await response.json();
    cache = { at: now(), keys: Array.isArray(body.keys) ? body.keys : [] };
    return cache.keys;
  }

  async function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw fail('OIDC_MALFORMED', 'token is not a JWT');
    const header = decodePart(parts[0]);
    const claims = decodePart(parts[1]);
    // Only RS256. Refusing everything else closes "alg: none" and HS256-with-
    // the-public-key confusion.
    if (header.alg !== 'RS256') throw fail('OIDC_BAD_ALG', `alg ${header.alg} not accepted`);

    let jwk = (await keys()).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await keys(true)).find(k => k.kid === header.kid); // GitHub rotated keys
    if (!jwk) throw fail('OIDC_UNKNOWN_KEY', 'signing key not in GitHub JWKS');
    const publicKey = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
    if (!valid) throw fail('OIDC_BAD_SIGNATURE', 'signature does not verify');

    const t = Math.floor(now() / 1000);
    const audience = env.OIDC_AUDIENCE || DEFAULT_AUDIENCE;
    const repository = env.GITHUB_OIDC_REPOSITORY || DEFAULT_REPOSITORY;
    if (claims.iss !== ISSUER) throw fail('OIDC_BAD_CLAIM', 'issuer');
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(audience)) throw fail('OIDC_BAD_CLAIM', 'audience');
    if (typeof claims.exp !== 'number' || claims.exp < t - SKEW_S) throw fail('OIDC_EXPIRED', 'token expired');
    if (typeof claims.nbf === 'number' && claims.nbf > t + SKEW_S) throw fail('OIDC_BAD_CLAIM', 'not yet valid');
    if (typeof claims.iat === 'number' && claims.iat > t + SKEW_S) throw fail('OIDC_BAD_CLAIM', 'issued in the future');
    if (claims.repository !== repository) throw fail('OIDC_BAD_CLAIM', 'repository');
    if (claims.ref !== 'refs/heads/main') throw fail('OIDC_BAD_CLAIM', 'ref must be refs/heads/main');
    if (!ALLOWED_EVENTS.includes(claims.event_name)) throw fail('OIDC_BAD_CLAIM', `event ${claims.event_name}`);
    const allowedRefs = ALLOWED_WORKFLOWS.map(w => `${repository}/.github/workflows/${w}@refs/heads/main`);
    if (!allowedRefs.includes(claims.job_workflow_ref)) throw fail('OIDC_BAD_CLAIM', 'workflow not allowed');

    return {
      repository: claims.repository,
      workflow: String(claims.job_workflow_ref).split('@')[0].split('/').pop(),
      event: claims.event_name,
      actor: claims.actor || null,
      runId: claims.run_id || null,
    };
  }

  return { verify };
}

module.exports = { createGithubOidcVerifier, ISSUER, JWKS_URL, DEFAULT_AUDIENCE, DEFAULT_REPOSITORY, ALLOWED_WORKFLOWS };

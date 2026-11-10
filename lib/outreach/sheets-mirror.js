'use strict';

/**
 * Mirror prospects into the working Google Sheet after each outreach run.
 *
 * Supabase (the `prospects` table) is the source of truth; the sheet is a
 * read-only mirror for people. Rows are APPENDED, one per prospect that was
 * created or changed during the run, so the tab doubles as a change log. If the
 * tab is empty a header row is written first.
 *
 * Auth is a Google service account (GOOGLE_SERVICE_ACCOUNT_JSON, the full key
 * JSON). The sheet must be shared with that account's client_email as Editor.
 * The OAuth token is minted here with node:crypto (RS256 JWT bearer grant), so
 * no googleapis dependency is added.
 *
 * Never fails the run: a mirror problem is reported in the summary, because a
 * sheet outage must not stop or repeat sends.
 */

const crypto = require('crypto');

const DEFAULT_SHEET_ID = '1Dwv2gD0BHsHmCgPKHBUR_qeC8msKWjiwL-o7OMAdPoE';
const DEFAULT_TAB = 'Pipeline';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const HEADER = Object.freeze([
  'Mirrored at', 'Prospect ID', 'Business', 'Email', 'Website', 'Region / city', 'State',
  'Campaign', 'Stage', 'Status', 'Last outreach step', 'Last outreach status', 'Source', 'Updated at',
]);

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function parseServiceAccount(raw) {
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (!parsed.client_email || !parsed.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON lacks client_email/private_key');
  return parsed;
}

function signedJwt(account, { now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: account.client_email, scope: SCOPE, aud: account.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

async function accessToken(account, fetchImpl) {
  const response = await fetchImpl(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt(account) }).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`Google token request failed (HTTP ${response.status}: ${body.error || 'no token'})`);
  return body.access_token;
}

function toRow(p, mirroredAt) {
  const b = p.business || {};
  const c = p.contact || {};
  const e = p.enrichment || {};
  return [
    mirroredAt, p.prospectId, b.displayName || b.name || '', c.email || '', b.website || b.domain || '',
    b.city || b.region || '', b.state || '', p.campaignId || '', p.stage || '', p.status || '',
    p.lastStep || '', p.lastQueueStatus || '', (e.source && (e.source.type || e.source)) || '',
    p.updatedAt ? new Date(p.updatedAt).toISOString() : '',
  ].map(v => (typeof v === 'string' ? v : String(v ?? '')));
}

/**
 * @param prospects mapped prospects (optionally carrying lastStep/lastQueueStatus)
 * @returns {{ status: 'mirrored'|'skipped'|'failed', rows, reason? }}
 */
async function mirrorProspects(prospects, { env = process.env, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return { status: 'skipped', rows: 0, reason: 'GOOGLE_SERVICE_ACCOUNT_JSON not set' };
  if (!prospects.length) return { status: 'skipped', rows: 0, reason: 'no new or changed prospects' };
  try {
    const account = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const sheetId = env.GOOGLE_SHEET_ID || DEFAULT_SHEET_ID;
    const tab = env.GOOGLE_SHEET_TAB || DEFAULT_TAB;
    const token = await accessToken(account, fetchImpl);
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values`;
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const head = await fetchImpl(`${base}/${encodeURIComponent(`${tab}!A1:A1`)}`, { headers: auth });
    const headBody = await head.json().catch(() => ({}));
    if (!head.ok) throw new Error(`reading ${tab}!A1 failed (HTTP ${head.status}: ${headBody.error?.message || 'unknown'})`);
    const values = [];
    if (!headBody.values || !headBody.values.length) values.push([...HEADER]);
    const mirroredAt = new Date(now).toISOString();
    for (const p of prospects) values.push(toRow(p, mirroredAt));

    const append = await fetchImpl(`${base}/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST', headers: auth, body: JSON.stringify({ values }),
    });
    const appendBody = await append.json().catch(() => ({}));
    if (!append.ok) throw new Error(`append failed (HTTP ${append.status}: ${appendBody.error?.message || 'unknown'})`);
    return { status: 'mirrored', rows: prospects.length };
  } catch (error) {
    return { status: 'failed', rows: 0, reason: error.message };
  }
}

module.exports = { mirrorProspects, signedJwt, toRow, parseServiceAccount, HEADER, DEFAULT_SHEET_ID, DEFAULT_TAB };

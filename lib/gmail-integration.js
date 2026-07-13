'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('./database');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly'
];

function required(name, env = process.env) {
  const value = env[name];
  if (!value) {
    const error = new Error(`${name} is required.`);
    error.code = 'GMAIL_CONFIGURATION_ERROR';
    throw error;
  }
  return value;
}

function getConfig(env = process.env) {
  const publicUrl = required('PUBLIC_APP_URL', env).replace(/\/$/, '');
  return {
    clientId: required('GOOGLE_CLIENT_ID', env),
    clientSecret: required('GOOGLE_CLIENT_SECRET', env),
    stateSecret: required('GMAIL_OAUTH_STATE_SECRET', env),
    encryptionKey: required('TOKEN_ENCRYPTION_KEY', env),
    redirectUri: env.GOOGLE_REDIRECT_URI || `${publicUrl}/oauth/google/callback`,
    publicUrl
  };
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signState(payload, secret) {
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function createOAuthState(secret, now = Date.now()) {
  return signState({ nonce: crypto.randomBytes(24).toString('hex'), issuedAt: now }, secret);
}

function verifyOAuthState(state, secret, now = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  const [encoded, supplied] = String(state || '').split('.');
  if (!encoded || !supplied) return false;
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof payload.issuedAt === 'number' && now >= payload.issuedAt && now - payload.issuedAt <= maxAgeMs;
  } catch {
    return false;
  }
}

function encryptionKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptToken(token, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decryptToken(payload, secret) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (parsed?.v !== 1) throw new Error('Unsupported encrypted token version.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]).toString('utf8');
}

function buildAuthorizationUrl(config, state) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: SCOPES.join(' '),
    state
  }).toString();
  return url.toString();
}

async function postForm(url, form, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error_description || body.error || `Google request failed (${response.status}).`);
    error.code = 'GOOGLE_OAUTH_ERROR';
    throw error;
  }
  return body;
}

async function exchangeCode(code, config, fetchImpl = fetch) {
  return postForm(GOOGLE_TOKEN_URL, {
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code'
  }, fetchImpl);
}

async function refreshAccessToken(refreshToken, config, fetchImpl = fetch) {
  return postForm(GOOGLE_TOKEN_URL, {
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token'
  }, fetchImpl);
}

async function gmailFetch(path, accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(`${GMAIL_API}${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Gmail API failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function headerValue(headers, name) {
  return (headers || []).find(header => String(header.name).toLowerCase() === name.toLowerCase())?.value || null;
}

function extractAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : String(value || '')).trim().toLowerCase() || null;
}

function normalizeMessage(message) {
  const headers = message.payload?.headers || [];
  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    historyId: message.historyId || null,
    from: extractAddress(headerValue(headers, 'From')),
    to: extractAddress(headerValue(headers, 'To')),
    subject: headerValue(headers, 'Subject'),
    internetMessageId: headerValue(headers, 'Message-ID'),
    inReplyTo: headerValue(headers, 'In-Reply-To'),
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : new Date().toISOString(),
    snippet: message.snippet || null
  };
}

async function saveConnection(tokens, profile, config) {
  if (!tokens.refresh_token) {
    const error = new Error('Google did not return a refresh token. Reconnect with consent prompt.');
    error.code = 'GOOGLE_REFRESH_TOKEN_MISSING';
    throw error;
  }
  const expiresAt = new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000);
  const result = await query(`
    INSERT INTO google_connections (provider, account_email, encrypted_refresh_token, encrypted_access_token, token_expires_at, scopes, status, gmail_history_id, last_error, updated_at)
    VALUES ('gmail', $1, $2, $3, $4, $5, 'active', $6, NULL, now())
    ON CONFLICT (provider, account_email) DO UPDATE SET
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      token_expires_at = EXCLUDED.token_expires_at,
      scopes = EXCLUDED.scopes,
      status = 'active',
      gmail_history_id = COALESCE(EXCLUDED.gmail_history_id, google_connections.gmail_history_id),
      last_error = NULL,
      updated_at = now()
    RETURNING connection_id, account_email, status, gmail_history_id, last_synced_at, created_at, updated_at
  `, [
    profile.emailAddress,
    encryptToken(tokens.refresh_token, config.encryptionKey),
    encryptToken(tokens.access_token, config.encryptionKey),
    expiresAt,
    String(tokens.scope || SCOPES.join(' ')).split(' '),
    profile.historyId || null
  ]);
  return result.rows[0];
}

async function activeConnection() {
  const result = await query(`SELECT * FROM google_connections WHERE provider = 'gmail' AND status = 'active' ORDER BY updated_at DESC LIMIT 1`);
  return result.rows[0] || null;
}

async function accessTokenFor(connection, config, fetchImpl = fetch) {
  if (connection.encrypted_access_token && connection.token_expires_at && new Date(connection.token_expires_at).getTime() > Date.now() + 60_000) {
    return decryptToken(connection.encrypted_access_token, config.encryptionKey);
  }
  const refreshToken = decryptToken(connection.encrypted_refresh_token, config.encryptionKey);
  const refreshed = await refreshAccessToken(refreshToken, config, fetchImpl);
  const expiresAt = new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000);
  await query(`UPDATE google_connections SET encrypted_access_token = $2, token_expires_at = $3, last_error = NULL, updated_at = now() WHERE connection_id = $1`, [
    connection.connection_id,
    encryptToken(refreshed.access_token, config.encryptionKey),
    expiresAt
  ]);
  return refreshed.access_token;
}

async function persistInboundMessage(connection, normalized) {
  return withTransaction(async client => {
    const prospect = normalized.from ? await client.query(`
      SELECT prospect_id FROM prospects
      WHERE lower(COALESCE(contact->>'email', '')) = $1
      ORDER BY updated_at DESC LIMIT 1
    `, [normalized.from]) : { rows: [] };
    const prospectId = prospect.rows[0]?.prospect_id || null;
    const inserted = await client.query(`
      INSERT INTO gmail_messages (connection_id, gmail_message_id, gmail_thread_id, internet_message_id, in_reply_to, direction, sender_email, recipient_email, subject, snippet, prospect_id, received_at, raw_metadata)
      VALUES ($1,$2,$3,$4,$5,'inbound',$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (connection_id, gmail_message_id) DO NOTHING
      RETURNING message_id
    `, [connection.connection_id, normalized.gmailMessageId, normalized.gmailThreadId, normalized.internetMessageId, normalized.inReplyTo, normalized.from, normalized.to, normalized.subject, normalized.snippet, prospectId, normalized.receivedAt, normalized]);
    if (!inserted.rowCount) return { inserted: false, prospectId };
    if (prospectId) {
      await client.query(`UPDATE prospects SET stage = 'replied', next_action = 'Representative follow-up required', next_action_at = now(), updated_at = now() WHERE prospect_id = $1`, [prospectId]);
      await client.query(`UPDATE outreach_queue SET status = 'stopped_reply', updated_at = now() WHERE prospect_id = $1 AND status IN ('pending','scheduled')`, [prospectId]);
      await client.query(`INSERT INTO prospect_events (prospect_id, type, actor, data) VALUES ($1, 'gmail_reply_received', 'gmail-sync', $2)`, [prospectId, normalized]);
    }
    return { inserted: true, prospectId };
  });
}

async function syncConnection(connection, config, fetchImpl = fetch) {
  const token = await accessTokenFor(connection, config, fetchImpl);
  const listing = await gmailFetch(`/messages?maxResults=100&q=${encodeURIComponent('newer_than:7d -from:me')}`, token, fetchImpl);
  let imported = 0;
  let matched = 0;
  let latestHistoryId = connection.gmail_history_id;
  for (const item of listing.messages || []) {
    const message = await gmailFetch(`/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=In-Reply-To`, token, fetchImpl);
    const normalized = normalizeMessage(message);
    latestHistoryId = normalized.historyId || latestHistoryId;
    const result = await persistInboundMessage(connection, normalized);
    if (result.inserted) imported += 1;
    if (result.inserted && result.prospectId) matched += 1;
  }
  await query(`UPDATE google_connections SET gmail_history_id = COALESCE($2, gmail_history_id), last_synced_at = now(), last_error = NULL, updated_at = now() WHERE connection_id = $1`, [connection.connection_id, latestHistoryId]);
  return { imported, matched, scanned: (listing.messages || []).length, historyId: latestHistoryId };
}

async function connectionStatus() {
  const result = await query(`SELECT connection_id, account_email, status, scopes, gmail_history_id, last_synced_at, last_error, token_expires_at, created_at, updated_at FROM google_connections WHERE provider = 'gmail' ORDER BY updated_at DESC LIMIT 1`);
  return result.rows[0] || { status: 'disconnected' };
}

async function disconnect() {
  const result = await query(`UPDATE google_connections SET status = 'disconnected', encrypted_refresh_token = NULL, encrypted_access_token = NULL, updated_at = now() WHERE provider = 'gmail' AND status = 'active' RETURNING connection_id`);
  return { disconnected: result.rowCount };
}

module.exports = {
  SCOPES, getConfig, createOAuthState, verifyOAuthState, encryptToken, decryptToken,
  buildAuthorizationUrl, exchangeCode, gmailFetch, normalizeMessage, saveConnection,
  activeConnection, syncConnection, connectionStatus, disconnect
};

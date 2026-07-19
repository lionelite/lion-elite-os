'use strict';

// X (Twitter) publisher: posts a single tweet via the v2 API using
// OAuth 1.0a user context (the auth mode available on the free tier for
// posting to your own account). No engagement surface — post only.

const crypto = require('crypto');

function percentEncode(value) {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build the OAuth 1.0a Authorization header for a request. Nonce and
 * timestamp are injectable so the signature is unit-testable.
 */
function buildOAuth1Header({ method, url, credentials, nonce, timestamp }) {
  const oauthParams = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0'
  };

  // JSON-body v2 requests sign only the oauth_* params.
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(oauthParams[key])}`)
    .join('&');
  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const header = { ...oauthParams, oauth_signature: signature };
  return 'OAuth ' + Object.keys(header)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(header[key])}"`)
    .join(', ');
}

async function publishTweet({ credentials, text }) {
  const url = 'https://api.twitter.com/2/tweets';
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: buildOAuth1Header({ method: 'POST', url, credentials })
    },
    body: JSON.stringify({ text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.detail || data.title || `X API HTTP ${response.status}`;
    throw Object.assign(new Error(message), { code: 'X_PUBLISH_FAILED', status: response.status });
  }
  return { id: data.data && data.data.id, platform: 'x' };
}

module.exports = { publishTweet, buildOAuth1Header, percentEncode };

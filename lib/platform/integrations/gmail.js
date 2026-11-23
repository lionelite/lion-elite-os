'use strict';

function normalizeGmailMessage(message = {}) {
  const headers = Object.fromEntries(
    (message.payload?.headers || []).map(h => [String(h.name || '').toLowerCase(), h.value || ''])
  );
  const bodyData = message.payload?.body?.data || '';
  let body = '';
  if (bodyData) {
    try { body = Buffer.from(bodyData, 'base64url').toString('utf8'); } catch (_error) {}
  }
  return {
    externalId: message.id || null,
    threadExternalId: message.threadId || null,
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '',
    body,
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    labelIds: Array.isArray(message.labelIds) ? message.labelIds : []
  };
}

class GmailAdapter {
  constructor({ accessToken, fetchImpl = fetch } = {}) {
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
  }

  assertConfigured() {
    if (!this.accessToken) {
      const error = new Error('Gmail access token is not configured');
      error.code = 'GMAIL_NOT_CONFIGURED';
      throw error;
    }
  }

  async api(path, options = {}) {
    this.assertConfigured();
    const response = await this.fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me' + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + this.accessToken,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const error = new Error('Gmail API request failed');
      error.status = response.status;
      error.detail = await response.text();
      throw error;
    }
    return response.json();
  }

  async listRecentInbound({ afterEpochSeconds, maxResults = 50 } = {}) {
    const q = ['in:inbox', afterEpochSeconds ? 'after:' + afterEpochSeconds : null].filter(Boolean).join(' ');
    const list = await this.api('/messages?q=' + encodeURIComponent(q) + '&maxResults=' + maxResults);
    const items = list.messages || [];
    const messages = [];
    for (const item of items) messages.push(await this.api('/messages/' + encodeURIComponent(item.id) + '?format=full'));
    return messages.map(normalizeGmailMessage);
  }
}

module.exports = { GmailAdapter, normalizeGmailMessage };

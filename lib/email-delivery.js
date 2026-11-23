'use strict';

const { log } = require('./observability');

function normalizeDraft(draft = {}, prospect = {}) {
  const recipient = draft.recipient || draft.to || prospect?.contact?.email || prospect?.email;
  const subject = draft.subject || 'A quick idea for your business';
  const text = draft.text || draft.body || draft.content || '';
  const html = draft.html || `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</div>`;
  return { recipient, subject, text, html };
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function assertDeliveryConfig() {
  if (String(process.env.OUTREACH_SEND_ENABLED).toLowerCase() !== 'true') {
    const error = new Error('Outbound delivery is disabled. Set OUTREACH_SEND_ENABLED=true.');
    error.code = 'DELIVERY_DISABLED';
    throw error;
  }
  if (!process.env.RESEND_API_KEY) {
    const error = new Error('RESEND_API_KEY is missing.');
    error.code = 'DELIVERY_CONFIG_MISSING';
    throw error;
  }
  if (!process.env.OUTREACH_FROM_EMAIL) {
    const error = new Error('OUTREACH_FROM_EMAIL is missing.');
    error.code = 'DELIVERY_CONFIG_MISSING';
    throw error;
  }
}

// CAN-SPAM requires a valid physical postal address and a working opt-out in
// every commercial email. Both are appended here, at the single send path,
// AFTER the draft's message version was computed and approved — so the footer
// can never be dropped by a template edit and never invalidates an approved
// version. OUTREACH_POSTAL_ADDRESS overrides the default address.
const DEFAULT_POSTAL_ADDRESS = 'Lion Elite Wellness, 28396 Detroit Road, Westlake, OH 44145';

function postalAddress(env = process.env) {
  return String(env.OUTREACH_POSTAL_ADDRESS || '').trim() || DEFAULT_POSTAL_ADDRESS;
}

function unsubscribeLine(env = process.env) {
  const address = env.OUTREACH_UNSUBSCRIBE_EMAIL || env.OUTREACH_REPLY_TO || '';
  return address
    ? `To unsubscribe, reply "unsubscribe" or email ${address} and you will not be contacted again.`
    : 'To unsubscribe, reply "unsubscribe" and you will not be contacted again.';
}

function appendPostalFooter(message, postal = postalAddress(), env = process.env) {
  const address = String(postal || '').trim() || DEFAULT_POSTAL_ADDRESS;
  const lines = [];
  if (!/unsubscribe/i.test(message.text || '')) lines.push(unsubscribeLine(env));
  if (!String(message.text || '').includes(address)) lines.push(address);
  if (!lines.length) return message;
  return {
    ...message,
    text: `${message.text}\n\n${lines.join('\n')}`,
    html: `${message.html}<div style="color:#888888;font-size:12px;margin-top:16px">${lines.map(escapeHtml).join('<br>')}</div>`
  };
}

/** Rate-limit / quota headers the provider returns: evidence of the account's real limits. Never secrets. */
function rateLimitHeaders(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, name) => {
    if (/^(x-)?ratelimit|quota|^retry-after$/i.test(name)) out[name.toLowerCase()] = String(value).slice(0, 100);
  });
  return out;
}

async function sendEmail({ draft, prospect, authorization, fetchImpl = fetch }) {
  assertDeliveryConfig();
  const message = appendPostalFooter(normalizeDraft(draft, prospect), postalAddress());
  if (!message.recipient || !message.recipient.includes('@')) {
    const error = new Error('A valid recipient email is required.');
    error.code = 'INVALID_RECIPIENT';
    throw error;
  }

  const payload = {
    from: process.env.OUTREACH_FROM_EMAIL,
    to: [message.recipient],
    subject: message.subject,
    html: message.html,
    text: message.text || undefined,
    reply_to: process.env.OUTREACH_REPLY_TO || process.env.OUTREACH_FROM_EMAIL,
    headers: {
      'X-Lion-Elite-Authorization': authorization?.idempotencyKey || 'authorized',
      'List-Unsubscribe': `<mailto:${process.env.OUTREACH_UNSUBSCRIBE_EMAIL || process.env.OUTREACH_REPLY_TO || process.env.OUTREACH_FROM_EMAIL}?subject=unsubscribe>`
    }
  };

  // A timeout or dropped connection is NOT proof the provider rejected the
  // message: it may have been accepted. Such errors are flagged `ambiguous` so
  // the caller holds the message as uncertain instead of marking it failed and
  // retrying it into a duplicate. Only a definitive provider answer (HTTP 4xx
  // other than 429) is a rejection. Retrying an uncertain message with the SAME
  // Idempotency-Key is safe while Resend still holds that key (24 h): Resend
  // returns the original result instead of sending again.
  let response;
  try {
    response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': authorization?.idempotencyKey || `outreach-${Date.now()}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(process.env.OUTREACH_PROVIDER_TIMEOUT_MS || 20000))
    });
  } catch (cause) {
    const error = new Error(`Email provider request did not complete (${cause.name === 'TimeoutError' ? 'timeout' : cause.message}); outcome unknown.`);
    error.code = 'DELIVERY_OUTCOME_UNKNOWN';
    error.ambiguous = true;
    throw error;
  }

  const providerLimits = rateLimitHeaders(response.headers);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || `Email provider returned HTTP ${response.status}.`);
    error.code = 'DELIVERY_PROVIDER_ERROR';
    error.providerStatus = response.status;
    error.providerResult = result;
    error.providerLimits = providerLimits;
    // 429 (rate or quota limit) and 5xx: the provider did not confirm a rejection.
    error.ambiguous = response.status === 429 || response.status >= 500;
    error.quotaExceeded = response.status === 429 && /quota/i.test(String(result.message || result.name || ''));
    throw error;
  }
  if (!result.id) {
    const error = new Error('Email provider answered 2xx without a message id; outcome unknown.');
    error.code = 'DELIVERY_OUTCOME_UNKNOWN';
    error.ambiguous = true;
    throw error;
  }

  log('info', 'email.sent', { recipient: message.recipient, provider: 'resend', providerId: result.id, messageVersion: draft?.messageVersion || null });
  return {
    status: 'sent',
    provider: 'resend',
    providerLimits,
    providerId: result.id,
    recipient: message.recipient,
    sentAt: new Date().toISOString()
  };
}

module.exports = { sendEmail, rateLimitHeaders, normalizeDraft, appendPostalFooter, postalAddress, unsubscribeLine, DEFAULT_POSTAL_ADDRESS };

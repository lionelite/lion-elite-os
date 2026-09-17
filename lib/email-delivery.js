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

// Resolve the addresses this send goes out under.
//
// With no identity, every value is read from the environment exactly as before
// — one entity, one from-address, unchanged behaviour. With an identity (from
// the entity registry), every value comes from that entity and NONE falls back
// to the environment: a second entity whose reply-to is unset must fall back to
// its OWN from-address, never to the first entity's. That fallback is the whole
// reason this parameter exists.
function resolveSenderAddresses(identity) {
  if (!identity) {
    return {
      from: process.env.OUTREACH_FROM_EMAIL,
      replyTo: process.env.OUTREACH_REPLY_TO || process.env.OUTREACH_FROM_EMAIL,
      unsubscribe: process.env.OUTREACH_UNSUBSCRIBE_EMAIL || process.env.OUTREACH_REPLY_TO || process.env.OUTREACH_FROM_EMAIL,
      postalAddress: process.env.OUTREACH_POSTAL_ADDRESS
    };
  }
  return {
    from: identity.from,
    replyTo: identity.replyTo || identity.from,
    unsubscribe: identity.unsubscribe || identity.replyTo || identity.from,
    postalAddress: identity.postalAddress
  };
}

function assertDeliveryConfig(from) {
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
  if (!from) {
    const error = new Error('OUTREACH_FROM_EMAIL is missing.');
    error.code = 'DELIVERY_CONFIG_MISSING';
    throw error;
  }
}

// CAN-SPAM requires a valid physical postal address in every commercial
// email. Set OUTREACH_POSTAL_ADDRESS and it is appended to both bodies.
function appendPostalFooter(message, postalAddress) {
  const postal = String(postalAddress || '').trim();
  if (!postal) return message;
  return {
    ...message,
    text: `${message.text}\n\n${postal}`,
    html: `${message.html}<div style="color:#888888;font-size:12px;margin-top:16px">${escapeHtml(postal)}</div>`
  };
}

async function sendEmail({ draft, prospect, authorization, identity }) {
  const sender = resolveSenderAddresses(identity);
  assertDeliveryConfig(sender.from);
  const message = appendPostalFooter(normalizeDraft(draft, prospect), sender.postalAddress);
  if (!message.recipient || !message.recipient.includes('@')) {
    const error = new Error('A valid recipient email is required.');
    error.code = 'INVALID_RECIPIENT';
    throw error;
  }

  const payload = {
    from: sender.from,
    to: [message.recipient],
    subject: message.subject,
    html: message.html,
    text: message.text || undefined,
    reply_to: sender.replyTo,
    headers: {
      'X-Lion-Elite-Authorization': authorization?.idempotencyKey || 'authorized',
      'List-Unsubscribe': `<mailto:${sender.unsubscribe}?subject=unsubscribe>`
    }
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': authorization?.idempotencyKey || `outreach-${Date.now()}`
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || `Email provider returned HTTP ${response.status}.`);
    error.code = 'DELIVERY_PROVIDER_ERROR';
    error.providerStatus = response.status;
    error.providerResult = result;
    throw error;
  }

  log('info', 'email.sent', { recipient: message.recipient, provider: 'resend', providerId: result.id, entityId: identity?.entityId || null });
  return {
    status: 'sent',
    provider: 'resend',
    providerId: result.id,
    recipient: message.recipient,
    sentAt: new Date().toISOString()
  };
}

module.exports = { sendEmail, normalizeDraft, appendPostalFooter, resolveSenderAddresses };

'use strict';

// Internal order-notification transport. Deliberately SEPARATE from the
// customer-outreach send path (lib/email-delivery.js): this is an internal ops
// alert to the business owner, gated by its own switch, and it must never be
// able to email a customer or ride the outreach quota/suppression rails.
//
// Fail-closed and NON-FATAL: if it isn't configured, it returns
// {status:'skipped'} instead of throwing, so a missing switch never blocks
// order processing. Enable with:
//   ORDER_NOTIFY_ENABLED=true
//   OWNER_ORDER_NOTIFICATION_EMAIL=ops@…            (where alerts go)
//   ORDER_NOTIFY_FROM=orders@…  (verified sender; falls back to OUTREACH_FROM_EMAIL)
//   RESEND_API_KEY=…            (reused email provider)

const { log } = require('../observability');

function orderNotifyConfig(env = process.env) {
  return {
    enabled: String(env.ORDER_NOTIFY_ENABLED).toLowerCase() === 'true',
    to: env.OWNER_ORDER_NOTIFICATION_EMAIL || '',
    from: env.ORDER_NOTIFY_FROM || env.OUTREACH_FROM_EMAIL || '',
    apiKey: env.RESEND_API_KEY || ''
  };
}

function notifyReadiness(env = process.env) {
  const c = orderNotifyConfig(env);
  const missing = [];
  if (!c.enabled) missing.push('ORDER_NOTIFY_ENABLED');
  if (!c.to) missing.push('OWNER_ORDER_NOTIFICATION_EMAIL');
  if (!c.from) missing.push('ORDER_NOTIFY_FROM|OUTREACH_FROM_EMAIL');
  if (!c.apiKey) missing.push('RESEND_API_KEY');
  return { ready: missing.length === 0, missing };
}

/**
 * Send one internal order-notification email. Never throws for config reasons.
 * @param {{subject:string, html:string, text?:string}} notification
 * @param {object} [opts] { fetchImpl, env }
 * @returns {Promise<{status:'sent'|'skipped'|'error', ...}>}
 */
async function sendOrderNotification(notification, { fetchImpl = fetch, env = process.env } = {}) {
  const { ready, missing } = notifyReadiness(env);
  if (!ready) return { status: 'skipped', reason: 'not_configured', missing };

  const c = orderNotifyConfig(env);
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: c.from,
        to: [c.to],
        subject: notification.subject,
        html: notification.html,
        text: notification.text || undefined
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      log('error', 'order_notify.provider_error', { status: response.status, message: result.message });
      return { status: 'error', providerStatus: response.status };
    }
    log('info', 'order_notify.sent', { to: c.to, providerId: result.id });
    return { status: 'sent', providerId: result.id, to: c.to };
  } catch (error) {
    log('error', 'order_notify.failed', { message: error.message });
    return { status: 'error', message: error.message };
  }
}

module.exports = { orderNotifyConfig, notifyReadiness, sendOrderNotification };

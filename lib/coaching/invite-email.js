'use strict';

const { generateToken, hashToken } = require('./security');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function publicBaseUrl() {
  return String(process.env.COACHING_PUBLIC_URL || 'https://lion-elite-os.onrender.com').replace(/\/$/, '');
}

function createInviteUrl(token) {
  return `${publicBaseUrl()}/coaching/#invite=${encodeURIComponent(token)}`;
}

function inviteEmailHtml(client, inviteUrl) {
  const firstName = escapeHtml(client.firstName || 'there');
  const safeUrl = escapeHtml(inviteUrl);
  return `<!doctype html>
<html>
  <body style="margin:0;background:#0a0908;color:#f6f2e8;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:620px;margin:0 auto;padding:36px 20px;">
      <div style="border:1px solid #2c281f;border-radius:22px;background:#11100e;padding:34px;">
        <div style="font-size:12px;letter-spacing:2px;color:#c8a96a;font-weight:700;margin-bottom:18px;">LION ELITE COACHING</div>
        <h1 style="font-size:30px;line-height:1.15;margin:0 0 16px;color:#ffffff;">Your coaching app is ready, ${firstName}.</h1>
        <p style="font-size:16px;line-height:1.7;color:#d2cdc3;margin:0 0 22px;">Your private Lion Elite app is where your training, progress, check-ins, coach messages and assigned plans live in one place.</p>
        <a href="${safeUrl}" style="display:inline-block;background:#c8a96a;color:#0a0908;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:12px;margin:4px 0 26px;">Open Lion Elite App</a>
        <div style="border-top:1px solid #2c281f;padding-top:22px;color:#bdb7ab;font-size:14px;line-height:1.7;">
          <strong style="color:#fff;">Install it on your phone</strong><br>
          iPhone: open the link in Safari → Share → Add to Home Screen.<br>
          Android: open the link in Chrome → Install app / Add to Home Screen.
        </div>
        <p style="font-size:13px;line-height:1.6;color:#8f897f;margin:22px 0 0;">This is a private one-time activation link and expires in 7 days. After activation, your device keeps a secure session so you can return directly to the app.</p>
      </div>
      <p style="text-align:center;color:#777168;font-size:12px;margin-top:18px;">The Lion Elite Team</p>
    </div>
  </body>
</html>`;
}

async function sendWithResend({ to, subject, html, fetchImpl = global.fetch }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return { sent: false, reason: 'RESEND_API_KEY_NOT_CONFIGURED' };
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for email delivery.');

  const from = String(process.env.COACHING_EMAIL_FROM || 'Lion Elite Coaching <info@lionelitewellness.com>').trim();
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || `Invite email delivery failed with status ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }
  return { sent: true, id: payload.id || null };
}

async function createAndSendClientInvite(store, client, options = {}) {
  if (!store || !client?.clientId || !client?.email) throw new Error('Client and coaching store are required.');
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await store.createInvite(client.clientId, hashToken(token), expiresAt);
  const inviteUrl = createInviteUrl(token);
  const delivery = await sendWithResend({
    to: client.email,
    subject: 'Your Lion Elite coaching app is ready',
    html: inviteEmailHtml(client, inviteUrl),
    fetchImpl: options.fetchImpl || global.fetch
  });
  return { inviteUrl, expiresAt, delivery };
}

module.exports = {
  createAndSendClientInvite,
  createInviteUrl,
  inviteEmailHtml,
  publicBaseUrl,
  sendWithResend
};

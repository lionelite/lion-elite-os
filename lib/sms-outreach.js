'use strict';

const DEFAULT_MESSAGE = "Hi {{firstName}}, this is Alex with Lion Elite Wellness. Just checking in to see how everything has been going since your order. If you have any questions or you're looking to continue your research, reply here and I'll be happy to help. Reply STOP to opt out.";

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function hasSmsMarketingConsent(customer) {
  const consent = customer?.sms_marketing_consent || customer?.smsMarketingConsent;
  const state = String(consent?.state || consent?.marketingState || '').toLowerCase();
  return state === 'subscribed' || state === 'confirmed_opt_in';
}

function selectCustomerPhone(order) {
  return normalizePhone(
    order?.customer?.phone ||
    order?.phone ||
    order?.shipping_address?.phone ||
    order?.billing_address?.phone
  );
}

function firstNameFor(order) {
  return String(
    order?.customer?.first_name ||
    order?.customer?.firstName ||
    order?.shipping_address?.first_name ||
    'there'
  ).trim() || 'there';
}

function renderMessage(template, customer) {
  return String(template || DEFAULT_MESSAGE).replace(/{{\s*firstName\s*}}/g, customer.firstName);
}

function buildEligibleRecipients(orders, { days = 45, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const byPhone = new Map();
  const skipped = [];

  for (const order of orders || []) {
    const createdAt = new Date(order.created_at || order.createdAt || 0);
    if (!Number.isFinite(createdAt.getTime()) || createdAt < cutoff) {
      skipped.push({ orderId: order.id, reason: 'outside_window' });
      continue;
    }
    if (!hasSmsMarketingConsent(order.customer)) {
      skipped.push({ orderId: order.id, reason: 'no_sms_marketing_consent' });
      continue;
    }
    const phone = selectCustomerPhone(order);
    if (!phone) {
      skipped.push({ orderId: order.id, reason: 'missing_or_invalid_phone' });
      continue;
    }
    const existing = byPhone.get(phone);
    if (!existing || createdAt > existing.lastOrderAt) {
      byPhone.set(phone, {
        phone,
        firstName: firstNameFor(order),
        lastOrderAt: createdAt,
        orderId: order.id
      });
    }
  }

  return {
    recipients: [...byPhone.values()].sort((a, b) => b.lastOrderAt - a.lastOrderAt),
    skipped
  };
}

async function fetchShopifyOrders({ shop, accessToken, apiVersion = '2026-04', days = 45, fetchImpl = fetch }) {
  if (!shop || !accessToken) throw new Error('SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN are required');
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const url = `https://${shop}/admin/api/${apiVersion}/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(cutoff)}`;
  const orders = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetchImpl(nextUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Accept': 'application/json'
      }
    });
    if (!response.ok) throw new Error(`Shopify orders request failed: ${response.status}`);
    const payload = await response.json();
    orders.push(...(payload.orders || []));
    const link = response.headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return orders;
}

async function sendTwilioMessage({ accountSid, authToken, messagingServiceSid, from, to, body, statusCallback, fetchImpl = fetch }) {
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
  if (!messagingServiceSid && !from) throw new Error('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER is required');
  const form = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
  else form.set('From', from);
  if (statusCallback) form.set('StatusCallback', statusCallback);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Twilio send failed: ${response.status} ${payload.message || ''}`.trim());
  return payload;
}

async function runCampaign(options = {}) {
  const days = Number(options.days || 45);
  const orders = options.orders || await fetchShopifyOrders({
    shop: options.shop,
    accessToken: options.shopifyAccessToken,
    apiVersion: options.shopifyApiVersion,
    days,
    fetchImpl: options.fetchImpl
  });
  const { recipients, skipped } = buildEligibleRecipients(orders, { days });
  const results = [];

  for (const recipient of recipients) {
    const body = renderMessage(options.messageTemplate, recipient);
    if (!options.send) {
      results.push({ phone: recipient.phone, firstName: recipient.firstName, status: 'dry_run', body });
      continue;
    }
    const sent = await sendTwilioMessage({
      accountSid: options.twilioAccountSid,
      authToken: options.twilioAuthToken,
      messagingServiceSid: options.twilioMessagingServiceSid,
      from: options.twilioFromNumber,
      statusCallback: options.statusCallback,
      to: recipient.phone,
      body,
      fetchImpl: options.fetchImpl
    });
    results.push({ phone: recipient.phone, firstName: recipient.firstName, status: sent.status, sid: sent.sid });
  }

  return { days, send: Boolean(options.send), eligible: recipients.length, skipped: skipped.length, results, skippedDetails: skipped };
}

module.exports = {
  DEFAULT_MESSAGE,
  normalizePhone,
  hasSmsMarketingConsent,
  buildEligibleRecipients,
  renderMessage,
  fetchShopifyOrders,
  sendTwilioMessage,
  runCampaign
};

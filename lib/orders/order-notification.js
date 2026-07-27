'use strict';

// Internal "NEW ORDER — ACTION REQUIRED" owner notification, reproduced from
// the Lion Elite Wellness store email and made brand-parameterized so the
// Lion Elite Beauty store gets the identical system.
//
// This is an INTERNAL ops alert to the business owner (not customer-facing
// outreach) — it tells the owner an order came in and links a "send receipt"
// action the owner clicks. It never emails the customer automatically.
//
// Two ways this is used:
//  1. As the exact spec/template to rebuild the notification in the Beauty
//     Orchids store (so it mirrors Wellness).
//  2. As a Stripe/Shopify order-webhook -> owner-email notifier owned in
//     LionOS, covering both stores from one place (see docs/order-notification.md).

const BRANDS = Object.freeze({
  wellness: {
    name: 'LION ELITE WELLNESS',
    displayName: 'Lion Elite Wellness',
    prefix: 'LEW',
    site: 'https://lionelitewellness.com',
    header: '#7a6416', headerText: '#f6e7b0', panel: '#141007', gold: '#b8902f', goldSoft: '#d9b85a'
  },
  beauty: {
    name: 'LION ELITE BEAUTY',
    displayName: 'Lion Elite Beauty',
    prefix: 'LEB',
    site: 'https://lionelitebeauty.com',
    header: '#7a6416', headerText: '#f6e7b0', panel: '#141007', gold: '#b8902f', goldSoft: '#d9b85a'
  }
});

function brandOf(key) {
  return BRANDS[key] || BRANDS.wellness;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v);
}

/**
 * Normalize a store webhook payload into a common order shape.
 * Supports Shopify order webhooks and Stripe checkout.session/payment_intent.
 * Returns { orderId, paymentVia, customer, shipTo, items, total }.
 */
function normalizeOrder(source, payload = {}, { brandKey = 'wellness' } = {}) {
  const b = brandOf(brandKey);
  const shortId = (payload.id || payload.name || payload.order_number || Date.now()).toString().replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();
  const orderId = `${b.prefix}-${shortId}`;

  if (source === 'shopify') {
    const c = payload.customer || {};
    const ship = payload.shipping_address || {};
    const items = (payload.line_items || []).map((li) => ({
      name: li.title || li.name, qty: Number(li.quantity) || 1, price: money(li.price)
    }));
    return {
      orderId, paymentVia: payload.gateway || payload.payment_gateway_names?.[0] || 'card',
      customer: {
        name: [c.first_name, c.last_name].filter(Boolean).join(' ') || payload.email || 'Customer',
        email: payload.email || c.email || '', phone: payload.phone || c.phone || ''
      },
      shipTo: {
        name: [ship.first_name, ship.last_name].filter(Boolean).join(' '),
        lines: [ship.address1, ship.address2, [ship.city, ship.province_code, ship.zip].filter(Boolean).join(', ')].filter(Boolean),
        method: (payload.shipping_lines || [])[0]?.title || ''
      },
      items, total: money(payload.total_price)
    };
  }

  // Stripe checkout.session.completed / payment_intent.succeeded
  const details = payload.customer_details || payload.charges?.data?.[0]?.billing_details || {};
  const ship = payload.shipping || details.address ? (payload.shipping || { name: details.name, address: details.address }) : {};
  const addr = ship.address || {};
  return {
    orderId,
    paymentVia: 'Stripe',
    customer: { name: details.name || ship.name || 'Customer', email: details.email || '', phone: details.phone || '' },
    shipTo: {
      name: ship.name || details.name || '',
      lines: [addr.line1, addr.line2, [addr.city, addr.state, addr.postal_code].filter(Boolean).join(', ')].filter(Boolean),
      method: ''
    },
    items: (payload.__items || []).map((li) => ({ name: li.name, qty: Number(li.qty) || 1, price: money(li.price) })),
    total: money(payload.amount_total != null ? payload.amount_total / 100 : payload.amount)
  };
}

function itemsRows(order, b) {
  return order.items.map((it) => `
      <tr>
        <td style="padding:12px 14px;border-top:1px solid #e3ddcb;color:#2a2a2a;font-size:14px;">${esc(it.name)}</td>
        <td align="center" style="padding:12px 14px;border-top:1px solid #e3ddcb;color:#2a2a2a;font-size:14px;">${esc(it.qty)}</td>
        <td align="right" style="padding:12px 14px;border-top:1px solid #e3ddcb;color:${b.gold};font-weight:bold;font-size:14px;">${esc(it.price)}</td>
      </tr>`).join('');
}

/**
 * Render the owner order-notification email HTML (matches the Wellness design).
 * @param {object} order  from normalizeOrder
 * @param {object} opts   { brandKey, receiptActionUrl }
 */
function renderOrderNotificationHtml(order, { brandKey = 'wellness', receiptActionUrl = '{{receipt_action_url}}' } = {}) {
  const b = brandOf(brandKey);
  const ship = order.shipTo || {};
  const c = order.customer || {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>New Order ${esc(order.orderId)}</title></head>
<body style="margin:0;padding:0;background:#0c0c0c;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:18px 12px;">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;font-family:Arial,Helvetica,sans-serif;border-radius:12px;overflow:hidden;">
    <tr><td style="background:${b.header};padding:16px 24px;color:${b.headerText};font-size:16px;font-weight:bold;letter-spacing:1px;">&#128722;&nbsp; NEW ORDER — ACTION REQUIRED</td></tr>
    <tr><td style="background:${b.panel};padding:22px 24px;">
      <div style="color:${b.goldSoft};font-size:12px;letter-spacing:4px;">${b.name} — INTERNAL NOTIFICATION</div>
      <div style="color:${b.goldSoft};font-size:30px;font-weight:800;padding-top:6px;">Order ${esc(order.orderId)}</div>
      <div style="color:#c9c2ad;font-size:14px;padding-top:8px;">Payment via <span style="color:${b.gold};font-weight:bold;">${esc(order.paymentVia)}</span> — awaiting your confirmation</div>
    </td></tr>
    <tr><td style="background:#f4f1e8;padding:22px 24px 6px;">
      <a href="${esc(receiptActionUrl)}" style="display:block;background:${b.header};color:#fdf6df;text-decoration:none;text-align:center;font-size:16px;font-weight:bold;padding:18px;border-radius:10px;">&#9989;&nbsp; Payment Received — Send Receipt to Customer</a>
      <div style="color:#8a8672;font-size:12px;text-align:center;padding:10px 0 4px;">Click after confirming payment cleared. Keep this link private.</div>
    </td></tr>
    <tr><td style="background:#f4f1e8;padding:14px 24px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="top" style="width:50%;">
          <div style="color:${b.gold};font-size:12px;font-weight:bold;letter-spacing:1px;">CUSTOMER</div>
          <div style="color:#2a2a2a;font-size:15px;padding-top:6px;">${esc(c.name)}</div>
          <div style="color:${b.gold};font-size:13px;">${esc(c.email)}</div>
          <div style="color:#555;font-size:13px;">${esc(c.phone)}</div>
        </td>
        <td valign="top" style="width:50%;">
          <div style="color:${b.gold};font-size:12px;font-weight:bold;letter-spacing:1px;">SHIP TO</div>
          <div style="color:#2a2a2a;font-size:15px;padding-top:6px;">${esc(ship.name || c.name)}</div>
          ${(ship.lines || []).map((l) => `<div style="color:${b.gold};font-size:13px;">${esc(l)}</div>`).join('')}
          ${ship.method ? `<div style="color:#555;font-size:13px;padding-top:4px;">${esc(ship.method)}</div>` : ''}
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#f4f1e8;padding:16px 24px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f1;border:1px solid #e3ddcb;border-radius:8px;">
        <tr>
          <td style="padding:10px 14px;color:#8a8672;font-size:11px;letter-spacing:1px;">PRODUCT</td>
          <td align="center" style="padding:10px 14px;color:#8a8672;font-size:11px;letter-spacing:1px;">QTY</td>
          <td align="right" style="padding:10px 14px;color:#8a8672;font-size:11px;letter-spacing:1px;">PRICE</td>
        </tr>
        ${itemsRows(order, b)}
        ${order.total ? `<tr><td colspan="2" align="right" style="padding:12px 14px;border-top:2px solid #e3ddcb;color:#2a2a2a;font-weight:bold;">Total</td><td align="right" style="padding:12px 14px;border-top:2px solid #e3ddcb;color:${b.gold};font-weight:bold;">${esc(order.total)}</td></tr>` : ''}
      </table>
    </td></tr>
    <tr><td style="background:${b.panel};padding:14px 24px;color:#8a8672;font-size:11px;">${b.name} internal order alert &#183; <a href="${b.site}" style="color:${b.goldSoft};text-decoration:none;">${b.site.replace('https://', '')}</a></td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function orderText(order) {
  const items = order.items.map((i) => `  ${i.qty}x ${i.name}  ${i.price}`).join('\n');
  return [
    `NEW ORDER — ACTION REQUIRED`,
    `Order ${order.orderId} — Payment via ${order.paymentVia} (awaiting confirmation)`,
    `Customer: ${order.customer.name} ${order.customer.email} ${order.customer.phone}`.trim(),
    `Ship to: ${(order.shipTo.lines || []).join(', ')} ${order.shipTo.method || ''}`.trim(),
    `Items:\n${items}`,
    order.total ? `Total: ${order.total}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * Build the full notification (subject + html + text). Subject keeps the
 * "🛒 New Order" convention so an inventory-sync workflow can find it.
 */
function buildOrderNotification(source, payload, { brandKey = 'wellness', receiptActionUrl } = {}) {
  const order = normalizeOrder(source, payload, { brandKey });
  return {
    order,
    subject: `🛒 New Order — ${brandOf(brandKey).displayName} — ${order.orderId}`,
    html: renderOrderNotificationHtml(order, { brandKey, receiptActionUrl }),
    text: orderText(order)
  };
}

// Is this webhook an order we should notify on?
function isOrderEvent(source, eventType = '') {
  const t = String(eventType).toLowerCase();
  if (source === 'shopify') return t.includes('order'); // orders/create, orders/paid
  if (source === 'stripe') return t === 'checkout.session.completed' || t === 'payment_intent.succeeded';
  return false;
}

// Which brand did the order come from? Prefer an explicit metadata.brand, else
// infer from the Shopify shop domain, else default to wellness.
function brandFromEvent({ metadata = {}, payload = {} } = {}) {
  const explicit = String(metadata.brand || payload?.metadata?.brand || '').toLowerCase();
  if (explicit === 'beauty' || explicit === 'wellness') return explicit;
  const hay = `${metadata.shopDomain || ''} ${payload?.order_status_url || ''} ${payload?.__brandHint || ''}`.toLowerCase();
  if (hay.includes('beauty')) return 'beauty';
  return 'wellness';
}

module.exports = {
  BRANDS, brandOf, normalizeOrder, renderOrderNotificationHtml, buildOrderNotification,
  isOrderEvent, brandFromEvent
};

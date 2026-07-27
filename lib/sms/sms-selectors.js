'use strict';

// SMS recipient selection. The strictest gate in the system, because texting
// the wrong person is a TCPA violation. A recipient is eligible ONLY if:
//  - they gave prior express written SMS marketing consent (smsConsent === true),
//  - they have a valid E.164 mobile number,
//  - they have NOT opted out (STOP) and are NOT suppressed,
//  - it is within their local quiet hours (8am–9pm), and
//  - they are past the campaign reorder cooldown.
// Everyone else is skipped with an explicit reason.

const { getSmsCampaign, withinQuietHours } = require('./sms-campaigns');

// E.164: leading +, country digit 1-9, up to 14 more digits.
const E164 = /^\+[1-9]\d{6,14}$/;

function hasValidMobile(r) {
  return typeof r.phone === 'string' && E164.test(r.phone.trim());
}

/**
 * @param {object[]} recipients stored customer records
 * @param {object} opts
 * @param {number} opts.now epoch ms (default Date.now())
 * @param {function} [opts.localHourFor] (recipient) => local hour 0-23; if
 *   omitted, uses recipient.localHour. Missing/unknown local time fails closed
 *   (skipped as unknown_local_time) — we never guess and risk an off-hours text.
 */
function selectSmsRecipients(recipients = [], { now = Date.now(), localHourFor } = {}) {
  const { reorderCooldownDays } = getSmsCampaign('client_research_reorder_sms');
  const cooldownMs = reorderCooldownDays * 86400000;
  const eligible = [];
  const skipped = [];

  for (const r of recipients) {
    let reason = null;
    if (r.smsConsent !== true) reason = 'no_sms_consent';
    else if (r.optedOut === true || r.smsOptedOut === true) reason = 'opted_out';
    else if (r.status === 'suppressed' || r.suppressed === true) reason = 'suppressed';
    else if (!hasValidMobile(r)) reason = 'invalid_mobile';
    else if (!r.lastPurchaseAt) reason = 'no_prior_purchase';
    else {
      const last = Date.parse(r.lastPurchaseAt);
      if (Number.isNaN(last)) reason = 'bad_last_purchase_date';
      else if (now - last < cooldownMs) reason = 'within_cooldown';
      else {
        const hour = localHourFor ? localHourFor(r) : r.localHour;
        if (typeof hour !== 'number' || Number.isNaN(hour)) reason = 'unknown_local_time';
        else if (!withinQuietHours(hour)) reason = 'outside_quiet_hours';
      }
    }
    if (reason) skipped.push({ id: r.prospectId || r.id || r.phone, reason });
    else eligible.push(r);
  }
  eligible.sort((a, b) => Date.parse(a.lastPurchaseAt) - Date.parse(b.lastPurchaseAt));
  return { eligible, skipped };
}

module.exports = { E164, hasValidMobile, selectSmsRecipients };

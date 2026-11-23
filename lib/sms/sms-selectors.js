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
/**
 * Campaign-specific eligibility, applied AFTER the checks every campaign shares.
 * Returns a skip reason or null.
 *
 * 'priorPurchase' is the reorder rule and is unchanged. 'optedIn' exists
 * because a freshly opted-in lead has no order history and would otherwise be
 * skipped as no_prior_purchase forever — the whole reason consent could never
 * lead anywhere. It is not a loosening: a welcome is sent once per lead and
 * never re-sent.
 */
function eligibilityReason(r, campaign, now) {
  if (campaign.eligibility === 'optedIn') {
    if (Array.isArray(campaign.lanes) && r.lane && !campaign.lanes.includes(r.lane)) return 'wrong_lane';
    const signedUp = Date.parse(r.createdAt || r.signedUpAt || '');
    if (Number.isNaN(signedUp)) return 'no_signup_date';
    const waitMs = (campaign.minMinutesSinceSignup || 0) * 60000;
    if (now - signedUp < waitMs) return 'too_soon_after_signup';
    if (campaign.oncePerLead && r.lastSmsSentAt) return 'already_sent';
    return null;
  }

  // Default: the reorder rule.
  if (!r.lastPurchaseAt) return 'no_prior_purchase';
  const last = Date.parse(r.lastPurchaseAt);
  if (Number.isNaN(last)) return 'bad_last_purchase_date';
  const cooldownMs = (campaign.reorderCooldownDays || 0) * 86400000;
  if (now - last < cooldownMs) return 'within_cooldown';
  return null;
}

/**
 * @param {string} [opts.campaignId] which campaign's rules to apply. Defaults to
 *   the reorder campaign so existing callers keep their exact behaviour.
 */
function selectSmsRecipients(recipients = [], { now = Date.now(), localHourFor, campaignId = 'client_research_reorder_sms' } = {}) {
  const campaign = getSmsCampaign(campaignId);
  const eligible = [];
  const skipped = [];

  for (const r of recipients) {
    // Shared gates first: these apply to every campaign and none of them is
    // ever campaign-configurable.
    let reason = null;
    if (r.smsConsent !== true) reason = 'no_sms_consent';
    else if (r.optedOut === true || r.smsOptedOut === true) reason = 'opted_out';
    else if (r.status === 'suppressed' || r.suppressed === true) reason = 'suppressed';
    else if (!hasValidMobile(r)) reason = 'invalid_mobile';
    else reason = eligibilityReason(r, campaign, now);

    if (!reason) {
      const hour = localHourFor ? localHourFor(r) : r.localHour;
      if (typeof hour !== 'number' || Number.isNaN(hour)) reason = 'unknown_local_time';
      else if (!withinQuietHours(hour)) reason = 'outside_quiet_hours';
    }

    if (reason) skipped.push({ id: r.prospectId || r.id || r.phone, reason });
    else eligible.push(r);
  }

  // Oldest first, by whichever date the campaign is keyed on.
  const orderKey = campaign.eligibility === 'optedIn'
    ? (x => Date.parse(x.createdAt || x.signedUpAt || 0) || 0)
    : (x => Date.parse(x.lastPurchaseAt) || 0);
  eligible.sort((a, b) => orderKey(a) - orderKey(b));
  return { eligible, skipped };
}

module.exports = { E164, hasValidMobile, selectSmsRecipients };

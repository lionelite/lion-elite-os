'use strict';

// SMS ("text") campaign registry (owner amendment 2026-07-27).
//
// Texting is far more regulated than email (TCPA in the US): it requires PRIOR
// EXPRESS WRITTEN CONSENT for marketing, an easy opt-out (STOP), sending only
// within local quiet hours (8am–9pm), and clear sender identification. Those
// aren't optional niceties — they're the law. So a campaign literally cannot
// be registered here unless it keeps every one of those controls plus the
// shared outreach safeguards (suppression, quota, Redis kill switch), and RUO
// content gating.
//
// Nothing here sends. Real sending stays fail-closed on SMS_SEND_ENABLED + the
// Twilio credentials (owner-set) and, per recipient, on stored consent.

const REQUIRED_SAFEGUARDS = Object.freeze([
  'consentRequired',   // prior express written consent, per recipient
  'optOut',            // STOP honored + suppression on opt-out
  'quietHours',        // only 8am–9pm recipient local time
  'suppressionCheck',
  'dailyQuota',
  'killSwitch'
]);

function assertSafeguards(campaign) {
  const s = campaign.safeguards || {};
  const missing = REQUIRED_SAFEGUARDS.filter((k) => s[k] !== true);
  if (missing.length) {
    throw new Error(`SMS campaign "${campaign.id}" cannot skip safeguards: ${missing.join(', ')}`);
  }
  if (campaign.complianceMode !== 'research-only') {
    throw new Error(`SMS campaign "${campaign.id}" must use research-only compliance mode (RUO posture).`);
  }
  if (campaign.audienceType !== 'consumer' && campaign.audienceType !== 'business') {
    throw new Error(`SMS campaign "${campaign.id}" needs an audienceType.`);
  }
  return campaign;
}

// Quiet-hours window (recipient local time), inclusive-exclusive: [8, 21).
const QUIET_HOURS = Object.freeze({ startHour: 8, endHour: 21 });

const SMS_CAMPAIGNS = Object.freeze({
  client_research_reorder_sms: assertSafeguards({
    id: 'client_research_reorder_sms',
    audienceType: 'consumer',
    complianceMode: 'research-only',
    messageBuilder: 'reorder',
    reorderCooldownDays: 45, // matches the email reorder cadence; do not re-text sooner
    safeguards: { consentRequired: true, optOut: true, quietHours: true, suppressionCheck: true, dailyQuota: true, killSwitch: true }
  })
});

function getSmsCampaign(id) {
  const c = SMS_CAMPAIGNS[id];
  if (!c) throw new Error(`Unknown SMS campaign: ${id}`);
  return c;
}

// A recipient's local hour is within the allowed window?
function withinQuietHours(localHour) {
  if (typeof localHour !== 'number' || Number.isNaN(localHour)) return false;
  return localHour >= QUIET_HOURS.startHour && localHour < QUIET_HOURS.endHour;
}

module.exports = {
  REQUIRED_SAFEGUARDS,
  QUIET_HOURS,
  SMS_CAMPAIGNS,
  assertSafeguards,
  getSmsCampaign,
  withinQuietHours
};

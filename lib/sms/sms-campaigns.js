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

// Modes the compliance validator enforces. Anything else fails closed rather
// than silently skipping brand rules.
const ALLOWED_COMPLIANCE_MODES = new Set(['research-only', 'coaching']);

function assertSafeguards(campaign) {
  const s = campaign.safeguards || {};
  const missing = REQUIRED_SAFEGUARDS.filter((k) => s[k] !== true);
  if (missing.length) {
    throw new Error(`SMS campaign "${campaign.id}" cannot skip safeguards: ${missing.join(', ')}`);
  }
  // Every campaign must declare a compliance mode, and it must be one the
  // validator actually enforces. This was research-only alone, because the
  // first campaign was Wellness. Beauty coaching messages are not RUO content
  // and would have had to either lie about their mode or bypass the registry —
  // both worse than naming the correct ruleset. 'coaching' is still gated: it
  // blocks medical claims, guarantees and outcome promises, and its
  // brand_separation rule keeps research compounds out of coaching texts.
  if (!ALLOWED_COMPLIANCE_MODES.has(campaign.complianceMode)) {
    throw new Error(
      `SMS campaign "${campaign.id}" needs a compliance mode of ` +
      `${[...ALLOWED_COMPLIANCE_MODES].join(' or ')}.`
    );
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
  }),

  // One welcome text to someone who just opted in on the Lion Elite Beauty
  // opt-in page. Coaching content, not research — hence the coaching mode.
  //
  // eligibility 'optedIn' rather than 'priorPurchase': these people have no
  // order history, and requiring one would make every opted-in lead
  // permanently unsendable. What replaces it is stricter in the ways that
  // matter — a single send per lead, enforced by last_sms_sent_at.
  coaching_welcome_sms: assertSafeguards({
    id: 'coaching_welcome_sms',
    audienceType: 'consumer',
    complianceMode: 'coaching',
    messageBuilder: 'coachingWelcome',
    eligibility: 'optedIn',
    // Do not text the instant a form is submitted; leaves room for a mistake
    // to be corrected and avoids looking like an autoresponder ambush.
    minMinutesSinceSignup: 5,
    // A welcome is sent once. There is no second welcome.
    oncePerLead: true,
    lanes: ['beauty-client', 'coach-platform'],
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

/**
 * The recipient's local hour from their IANA zone, or null when it cannot be
 * determined. Null is not a fallback to server time — the selector treats it as
 * unknown_local_time and skips, because guessing risks a 3am text.
 */
function localHourIn(timezone, now = Date.now()) {
  const zone = String(timezone || '').trim();
  if (!zone) return null;
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: 'numeric', hour12: false
    }).format(new Date(now));
    const parsed = Number(hour);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  REQUIRED_SAFEGUARDS,
  ALLOWED_COMPLIANCE_MODES,
  localHourIn,
  QUIET_HOURS,
  SMS_CAMPAIGNS,
  assertSafeguards,
  getSmsCampaign,
  withinQuietHours
};

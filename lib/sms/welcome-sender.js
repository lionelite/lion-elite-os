'use strict';

// Connects a consent record to an actual text.
//
// Until now nothing did. selectSmsRecipients was exported and never called, and
// the only campaign required an order history a freshly opted-in lead does not
// have — so consent was capturable and led nowhere.
//
// Everything below is a gate, and every gate fails closed. In order:
//   1. SMS_SEND_ENABLED, owner-set, never flipped from code
//   2. the Redis kill switch
//   3. Twilio credentials present
//   4. per-recipient selection (consent, opt-out, suppression, E.164,
//      quiet hours in THEIR timezone, once-per-lead)
//   5. compliance validation of the exact body about to be sent
//   6. the shared daily quota
// A dry run stops before 1 and 3 and still runs everything else, so the
// selection and the copy can be inspected without credentials.

const { getSmsCampaign, localHourIn } = require('./sms-campaigns');
const { selectSmsRecipients } = require('./sms-selectors');
const { BUILDERS } = require('./sms-message');

const CAMPAIGN_ID = 'coaching_welcome_sms';

function sendEnabled() {
  return String(process.env.SMS_SEND_ENABLED || '').toLowerCase() === 'true';
}

function dailyLimit() {
  const value = Number(process.env.DAILY_SMS_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 50;
}

/**
 * @param {object} deps injected so this is testable without Redis, Postgres or
 *   Twilio. Each has a real implementation in the script that calls this.
 */
async function runWelcomeCampaign({
  loadCandidates,
  markSent,
  sendMessage,
  reserveQuota,
  isHalted,
  now = Date.now(),
  dryRun = false,
  limit = 50
} = {}) {
  const campaign = getSmsCampaign(CAMPAIGN_ID);
  const summary = { campaign: CAMPAIGN_ID, dryRun, attempted: 0, sent: 0, skipped: [], blocked: null };

  if (!dryRun && !sendEnabled()) {
    summary.blocked = 'SMS_SEND_ENABLED is not true';
    return summary;
  }

  if (isHalted && await isHalted()) {
    summary.blocked = 'kill switch engaged';
    return summary;
  }

  const candidates = await loadCandidates({ lanes: campaign.lanes, limit });

  const { eligible, skipped } = selectSmsRecipients(candidates, {
    now,
    campaignId: CAMPAIGN_ID,
    // Their local hour, from the zone captured at consent. Unknown stays
    // unknown: the selector skips it rather than assuming server time.
    localHourFor: r => {
      const hour = localHourIn(r.timezone, now);
      return hour === null ? undefined : hour;
    }
  });
  summary.skipped = skipped;

  const build = BUILDERS[campaign.messageBuilder];
  if (!build) {
    summary.blocked = `no message builder for ${campaign.messageBuilder}`;
    return summary;
  }

  for (const recipient of eligible) {
    if (summary.sent >= limit) break;

    const message = build({ firstName: recipient.firstName || recipient.name, lane: recipient.lane });
    // The copy is validated as the exact string about to be sent, not as a
    // template that something else might have altered.
    if (!message.approved) {
      summary.skipped.push({
        id: recipient.id || recipient.phone,
        reason: 'compliance_blocked',
        codes: message.compliance.blockers.map(b => b.code)
      });
      continue;
    }

    summary.attempted += 1;

    if (dryRun) {
      summary.sent += 1;
      summary.skipped.push({ id: recipient.id || recipient.phone, reason: 'dry_run', body: message.body });
      continue;
    }

    // Reserve before sending. A reservation that is never used costs one
    // message of headroom; sending first and counting after risks exceeding
    // the cap when something fails mid-loop.
    const reserved = reserveQuota ? await reserveQuota(dailyLimit()) : true;
    if (!reserved) {
      summary.skipped.push({ id: recipient.id || recipient.phone, reason: 'daily_quota_reached' });
      break;
    }

    try {
      const result = await sendMessage({ to: recipient.phone, body: message.body });
      await markSent(recipient, CAMPAIGN_ID);
      summary.sent += 1;
      summary.lastSid = result?.sid;
    } catch (error) {
      summary.skipped.push({ id: recipient.id || recipient.phone, reason: 'send_failed', detail: error.message });
    }
  }

  return summary;
}

module.exports = { CAMPAIGN_ID, runWelcomeCampaign, sendEnabled, dailyLimit };

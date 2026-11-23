'use strict';

const { query } = require('../database');

/**
 * Persist a captured lead.
 *
 * Re-submitting is normal — people fill a form twice, or come back later and
 * add their phone. So this upserts on (email, lane) and merges upward: consent
 * can be granted on a later visit, but a submission that simply omits the box
 * never revokes consent already given. Revocation is an explicit act
 * (unsubscribe), not an absent checkbox.
 */
async function saveCapture(capture) {
  const result = await query(
    `INSERT INTO captured_leads (
       lane, name, email, phone, source, status,
       email_marketing_consent, email_consent_at,
       sms_marketing_consent, sms_consent_at, sms_consent_text,
       sms_consent_ip, sms_consent_user_agent, timezone
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (lower(email), lane) DO UPDATE SET
       name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE captured_leads.name END,
       phone = COALESCE(EXCLUDED.phone, captured_leads.phone),
       source = EXCLUDED.source,
       email_marketing_consent = captured_leads.email_marketing_consent OR EXCLUDED.email_marketing_consent,
       email_consent_at = COALESCE(captured_leads.email_consent_at, EXCLUDED.email_consent_at),
       sms_marketing_consent = captured_leads.sms_marketing_consent OR EXCLUDED.sms_marketing_consent,
       sms_consent_at = COALESCE(captured_leads.sms_consent_at, EXCLUDED.sms_consent_at),
       sms_consent_text = COALESCE(captured_leads.sms_consent_text, EXCLUDED.sms_consent_text),
       sms_consent_ip = COALESCE(captured_leads.sms_consent_ip, EXCLUDED.sms_consent_ip),
       sms_consent_user_agent = COALESCE(captured_leads.sms_consent_user_agent, EXCLUDED.sms_consent_user_agent),
       timezone = COALESCE(EXCLUDED.timezone, captured_leads.timezone),
       updated_at = now()
     RETURNING *`,
    [
      capture.lane, capture.name, capture.email, capture.phone, capture.source, capture.status,
      capture.emailMarketingConsent, capture.emailConsentAt,
      capture.smsMarketingConsent, capture.smsConsentAt, capture.smsConsentText,
      capture.smsConsentIp, capture.smsConsentUserAgent, capture.timezone
    ]
  );
  return mapLead(result.rows[0]);
}

/** Honour an opt-out. Consent ends here; the row stays as the record of it. */
async function unsubscribe(email, lane) {
  const result = await query(
    `UPDATE captured_leads
     SET unsubscribed_at = now(),
         email_marketing_consent = false,
         sms_marketing_consent = false,
         updated_at = now()
     WHERE lower(email) = lower($1) AND ($2::text IS NULL OR lane = $2)
     RETURNING *`,
    [email, lane || null]
  );
  return result.rows.map(mapLead);
}

/** Leads that may lawfully be texted: consented, phoned, not opted out. */
async function listSmsReachable(lane, limit = 100) {
  const result = await query(
    `SELECT * FROM captured_leads
     WHERE sms_marketing_consent = true
       AND unsubscribed_at IS NULL
       AND phone IS NOT NULL
       AND ($1::text IS NULL OR lane = $1)
     ORDER BY created_at DESC
     LIMIT $2`,
    [lane || null, limit]
  );
  return result.rows.map(mapLead);
}

/**
 * Candidates for a welcome text: consented, still subscribed, with a number.
 * The remaining eligibility (quiet hours, timing, once-per-lead) belongs to the
 * selector, which is the single place those rules live.
 */
async function listWelcomeCandidates({ lanes = null, limit = 50 } = {}) {
  const result = await query(
    `SELECT * FROM captured_leads
     WHERE sms_marketing_consent = true
       AND unsubscribed_at IS NULL
       AND phone IS NOT NULL
       AND last_sms_sent_at IS NULL
       AND ($1::text[] IS NULL OR lane = ANY($1))
     ORDER BY created_at ASC
     LIMIT $2`,
    [lanes, limit]
  );
  return result.rows.map(row => ({
    ...mapLead(row),
    // Shapes the row for the selector, which reads these names.
    id: row.lead_id,
    firstName: String(row.name || '').trim().split(/\s+/)[0] || '',
    smsConsent: row.sms_marketing_consent,
    optedOut: row.unsubscribed_at !== null
  }));
}

/** Record that a campaign texted this lead, which is what makes it once-only. */
async function markSmsSent(lead, campaignId) {
  await query(
    `UPDATE captured_leads
     SET last_sms_sent_at = now(), last_sms_campaign = $2, updated_at = now()
     WHERE lead_id = $1`,
    [lead.leadId || lead.id, campaignId]
  );
}

/**
 * Take one unit of the shared daily SMS allowance, atomically.
 *
 * Reserving before sending means a crash costs one message of headroom rather
 * than letting a retry loop exceed the cap.
 */
async function reserveSmsQuota(limit) {
  const result = await query(
    `INSERT INTO daily_usage (usage_day, channel, sent_count)
     VALUES (CURRENT_DATE, 'sms', 1)
     ON CONFLICT (usage_day, channel) DO UPDATE
       SET sent_count = daily_usage.sent_count + 1
       WHERE daily_usage.sent_count < $1
     RETURNING sent_count`,
    [limit]
  );
  return result.rows.length > 0;
}

function mapLead(row) {
  if (!row) return null;
  return {
    leadId: row.lead_id,
    lane: row.lane,
    name: row.name,
    email: row.email,
    phone: row.phone,
    source: row.source,
    status: row.status,
    emailMarketingConsent: row.email_marketing_consent,
    emailConsentAt: row.email_consent_at,
    smsMarketingConsent: row.sms_marketing_consent,
    smsConsentAt: row.sms_consent_at,
    timezone: row.timezone || null,
    lastSmsSentAt: row.last_sms_sent_at || null,
    lastSmsCampaign: row.last_sms_campaign || null,
    // The disclosure text and origin stay in the database as the consent
    // record; they are not part of what the API hands back.
    unsubscribedAt: row.unsubscribed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  saveCapture,
  unsubscribe,
  listSmsReachable,
  listWelcomeCandidates,
  markSmsSent,
  reserveSmsQuota,
  mapLead
};

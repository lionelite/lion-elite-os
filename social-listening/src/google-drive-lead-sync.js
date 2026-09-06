'use strict';

// Google Drive / Sheets lead archive bridge.
//
// LionOS cannot assume a Google credential is present in every runtime. This
// bridge therefore posts a normalized prospect payload to a configured Google
// Apps Script / automation webhook that appends or upserts the row in the
// owner's Google Sheet. If the webhook is not configured, the function returns
// a structured "not configured" result without interrupting lead capture.
//
// Required runtime env:
//   GOOGLE_DRIVE_LEAD_WEBHOOK_URL=<deployed Apps Script / automation webhook>
// Optional:
//   GOOGLE_DRIVE_LEAD_SHEET_ID=<target sheet id, echoed in payload>
//   GOOGLE_DRIVE_LEAD_SYNC_TOKEN=<shared secret sent as x-lionos-token>

const DEFAULT_TIMEOUT_MS = 5000;

function first(values) {
  return Array.isArray(values) && values.length ? values[0] : null;
}

function sourceFor(contactSources, type) {
  if (!Array.isArray(contactSources)) return null;
  for (const source of contactSources) {
    if (!source || !source.url) continue;
    if (type === 'email' && Array.isArray(source.emails) && source.emails.length) return source.url;
    if (type === 'phone' && Array.isArray(source.phones) && source.phones.length) return source.url;
  }
  return null;
}

function normalizeProspectForDrive(prospect, { event = 'lead_upsert' } = {}) {
  const business = prospect?.business || {};
  const contact = prospect?.contact || {};
  const enrichment = prospect?.enrichment || {};
  const sources = contact.publicContactSources || [];
  const publicEmail = first(contact.publicBusinessEmails);
  const publicPhone = first(contact.publicBusinessPhones);

  return {
    event,
    sheetId: process.env.GOOGLE_DRIVE_LEAD_SHEET_ID || null,
    prospectId: prospect?.prospectId || null,
    leadScore: Number(prospect?.score || business.opportunityScore || 0),
    niche: business.niche || enrichment.niche || null,
    blueskyDid: contact.blueskyDid || business.sourceDid || null,
    blueskyHandle: contact.blueskyHandle || null,
    displayName: business.displayName || null,
    latestPostText: business.latestPostText || null,
    latestPostUrl: business.latestPostUrl || business.sourceUrl || null,
    profileUrl: contact.blueskyProfileUrl || business.profileUrl || null,
    intentSignals: business.intentSignals || enrichment.intentSignals || [],
    valueSignals: business.valueSignals || enrichment.valueSignals || [],
    websiteUrls: business.websiteUrls || [],
    publicEmail,
    emailSourceUrl: publicEmail ? sourceFor(sources, 'email') : null,
    publicPhone,
    phoneSourceUrl: publicPhone ? sourceFor(sources, 'phone') : null,
    contactEvidence: sources,
    consentStatus: contact.outreachConsent === true ? 'consented' : 'not_consent_confirmed',
    outreachEligible: contact.outreachEligible === true,
    status: prospect?.status || null,
    nextAction: prospect?.nextAction || null,
    owner: prospect?.ownerId || 'bluesky-listener',
    firstSeen: prospect?.createdAt || null,
    lastSeen: enrichment.lastSeenAt || business.latestPostAt || new Date().toISOString(),
    campaign: prospect?.campaignId || null,
    syncedAt: new Date().toISOString()
  };
}

async function syncProspectToGoogleDrive(prospect, options = {}) {
  const webhookUrl = options.webhookUrl || process.env.GOOGLE_DRIVE_LEAD_WEBHOOK_URL;
  if (!webhookUrl) {
    return { synced: false, reason: 'GOOGLE_DRIVE_LEAD_WEBHOOK_URL_NOT_CONFIGURED' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    const token = process.env.GOOGLE_DRIVE_LEAD_SYNC_TOKEN;
    if (token) headers['x-lionos-token'] = token;

    const response = await (options.fetchImpl || fetch)(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(normalizeProspectForDrive(prospect, options)),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`GOOGLE_DRIVE_SYNC_HTTP_${response.status}`);
    return { synced: true };
  } finally {
    clearTimeout(timer);
  }
}

function scheduleGoogleDriveSync(prospect, options = {}) {
  if (!prospect?.prospectId) return;
  setImmediate(async () => {
    try {
      const result = await syncProspectToGoogleDrive(prospect, options);
      if (!result.synced && result.reason !== 'GOOGLE_DRIVE_LEAD_WEBHOOK_URL_NOT_CONFIGURED') {
        console.error(`[listen] Google Drive lead sync skipped ${prospect.prospectId}: ${result.reason}`);
      }
    } catch (error) {
      console.error(`[listen] Google Drive lead sync error ${prospect.prospectId}: ${error.message}`);
    }
  });
}

module.exports = {
  normalizeProspectForDrive,
  syncProspectToGoogleDrive,
  scheduleGoogleDriveSync
};

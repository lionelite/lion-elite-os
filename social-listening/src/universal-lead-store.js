'use strict';

const { PostgresProspectStore } = require('../../lib/postgres-prospect-store');
const { enrichPublicContact } = require('./public-contact-enrichment');
const { scheduleGoogleDriveSync } = require('./google-drive-lead-sync');

const CAMPAIGN_ID = 'bluesky-universal-leads';
const AUDIENCE_CAMPAIGN_ID = 'bluesky-audience-leads';
const store = new PostgresProspectStore();

function profileUrl(did) {
  return did ? `https://bsky.app/profile/${encodeURIComponent(did)}` : null;
}

function shouldEnrichPublicContact(score) {
  if (process.env.BLUESKY_ENRICH_PUBLIC_CONTACTS === 'false') return false;
  const minScore = Number(process.env.BLUESKY_ENRICH_MIN_SCORE || 70);
  return Number(score || 0) >= (Number.isFinite(minScore) ? minScore : 70);
}

function schedulePublicContactEnrichment(prospect) {
  if (!prospect?.prospectId || !prospect?.contact?.blueskyDid) return;
  if (!shouldEnrichPublicContact(prospect.score)) return;

  setImmediate(async () => {
    try {
      const publicContact = await enrichPublicContact(prospect.contact.blueskyDid);
      const publicEmails = Array.isArray(publicContact.publicEmails) ? publicContact.publicEmails : [];
      const publicPhones = Array.isArray(publicContact.publicPhones) ? publicContact.publicPhones : [];
      const hasPublicContact = publicEmails.length > 0 || publicPhones.length > 0;

      const enriched = await store.update(prospect.prospectId, {
        business: {
          ...(prospect.business || {}),
          displayName: publicContact.displayName || prospect.business?.displayName || publicContact.handle || prospect.contact.blueskyDid,
          profileUrl: publicContact.profileUrl || prospect.business?.profileUrl,
          websiteUrls: publicContact.websiteUrls || prospect.business?.websiteUrls || []
        },
        contact: {
          ...(prospect.contact || {}),
          blueskyHandle: publicContact.handle,
          blueskyProfileUrl: publicContact.profileUrl,
          publicBusinessEmails: publicEmails,
          publicBusinessPhones: publicPhones,
          publicContactSources: publicContact.sources || [],
          outreachConsent: false,
          outreachEligible: false
        },
        enrichment: {
          ...(prospect.enrichment || {}),
          publicContact: {
            status: hasPublicContact ? 'found' : 'not_found',
            policy: publicContact.enrichmentPolicy,
            emailsFound: publicEmails.length,
            phonesFound: publicPhones.length,
            enrichedAt: publicContact.enrichedAt
          }
        },
        nextAction: hasPublicContact
          ? 'review_public_contact_and_outreach_eligibility'
          : prospect.nextAction || 'review_high_priority_bluesky_lead'
      }, 'bluesky-public-contact-enrichment');

      // Update the same Drive row after enrichment so the archive gets the
      // public contact details and evidence without creating a duplicate lead.
      scheduleGoogleDriveSync(enriched, { event: 'lead_enriched' });
    } catch (error) {
      try {
        await store.update(prospect.prospectId, {
          enrichment: {
            ...(prospect.enrichment || {}),
            publicContact: {
              status: 'error',
              error: error.message,
              enrichedAt: new Date().toISOString()
            }
          }
        }, 'bluesky-public-contact-enrichment');
      } catch {
        // Listener availability is more important than enrichment telemetry.
      }
      console.error(`[listen] Public contact enrichment error ${prospect.contact.blueskyDid}: ${error.message}`);
    }
  });
}

async function persistBlueskyLead(post, lead, campaignId = CAMPAIGN_ID) {
  if (!process.env.DATABASE_URL) return { stored: false, reason: 'DATABASE_URL_NOT_CONFIGURED' };

  const business = {
    name: `Bluesky ${post.did}`,
    displayName: post.did,
    region: 'bluesky',
    sourcePlatform: 'bluesky',
    sourceDid: post.did,
    sourceUrl: post.url,
    profileUrl: profileUrl(post.did),
    niche: lead.niche,
    opportunityScore: lead.opportunityScore,
    latestPostText: post.text,
    latestPostUrl: post.url,
    latestPostRkey: post.rkey,
    latestPostAt: post.createdAt || new Date().toISOString(),
    intentSignals: lead.intentSignals,
    valueSignals: lead.valueSignals
  };

  const created = await store.create({
    business,
    contact: {
      blueskyDid: post.did,
      blueskyProfileUrl: profileUrl(post.did),
      outreachConsent: false,
      outreachEligible: false
    },
    campaignId,
    ownerId: 'bluesky-listener'
  }, 'bluesky-listener');

  const prospect = created.prospect;
  const previousBusiness = prospect.business || {};
  const recentPosts = Array.isArray(previousBusiness.recentPosts) ? previousBusiness.recentPosts : [];
  const mergedPosts = [
    {
      rkey: post.rkey,
      url: post.url,
      text: post.text,
      createdAt: post.createdAt || null,
      seenAt: new Date().toISOString(),
      opportunityScore: lead.opportunityScore,
      niche: lead.niche
    },
    ...recentPosts.filter(item => item?.rkey !== post.rkey)
  ].slice(0, 10);

  const bestScore = Math.max(Number(prospect.score || 0), Number(lead.opportunityScore || 0));
  const updated = await store.update(prospect.prospectId, {
    business: {
      ...previousBusiness,
      ...business,
      recentPosts: mergedPosts
    },
    contact: {
      ...(prospect.contact || {}),
      blueskyDid: post.did,
      blueskyProfileUrl: profileUrl(post.did),
      outreachConsent: false,
      outreachEligible: false
    },
    score: bestScore,
    enrichment: {
      ...(prospect.enrichment || {}),
      source: 'bluesky-listener',
      niche: lead.niche,
      latestOpportunityScore: lead.opportunityScore,
      intentSignals: lead.intentSignals,
      valueSignals: lead.valueSignals,
      lastSeenAt: new Date().toISOString()
    },
    nextAction: bestScore >= 70 ? 'review_high_priority_bluesky_lead' : 'monitor_bluesky_lead'
  }, 'bluesky-listener');

  // Every stored lead is mirrored to Google Drive immediately, even when the
  // lead does not qualify for public-contact enrichment.
  scheduleGoogleDriveSync(updated, { event: created.duplicate ? 'lead_updated' : 'lead_created' });
  schedulePublicContactEnrichment(updated);
  return { stored: true, duplicate: created.duplicate, prospect: updated };
}

function persistUniversalLead(post, lead) {
  return persistBlueskyLead(post, lead, CAMPAIGN_ID);
}

function persistAudienceMatch(post, match) {
  if (!match || match.doNotEngage) {
    return Promise.resolve({ stored: false, reason: 'DO_NOT_ENGAGE' });
  }
  return persistBlueskyLead(post, {
    niche: match.audience,
    opportunityScore: match.score,
    intentSignals: match.matched?.intent || [],
    valueSignals: match.matched?.subject || []
  }, AUDIENCE_CAMPAIGN_ID);
}

module.exports = {
  persistBlueskyLead,
  persistUniversalLead,
  persistAudienceMatch,
  shouldEnrichPublicContact,
  schedulePublicContactEnrichment,
  CAMPAIGN_ID,
  AUDIENCE_CAMPAIGN_ID
};

'use strict';

const { PostgresProspectStore } = require('./postgres-prospect-store');

const prospectStore = new PostgresProspectStore();

function summarize(source, type, payload) {
  if (source === 'shopify') {
    return {
      orderId: payload?.id || payload?.order_id || null,
      customerEmail: payload?.email || payload?.customer?.email || null,
      total: Number(payload?.current_total_price || payload?.total_price || 0),
      currency: payload?.currency || null,
      financialStatus: payload?.financial_status || null
    };
  }
  if (source === 'gmail') {
    return {
      messageId: payload?.messageId || payload?.id || null,
      from: payload?.from || null,
      subject: payload?.subject || null,
      intent: payload?.intent || null,
      urgency: payload?.urgency || null
    };
  }
  if (source === 'calendar') {
    return {
      eventId: payload?.eventId || payload?.id || null,
      title: payload?.title || payload?.summary || null,
      startsAt: payload?.startsAt || payload?.start?.dateTime || payload?.start || null,
      attendeeCount: Array.isArray(payload?.attendees) ? payload.attendees.length : null
    };
  }
  if (source === 'ads') {
    return {
      campaignId: payload?.campaignId || payload?.campaign_id || null,
      spend: Number(payload?.spend || 0),
      revenue: Number(payload?.revenue || payload?.conversionValue || 0),
      leads: Number(payload?.leads || 0)
    };
  }
  if (source === 'affiliate') {
    return {
      organization: payload?.organization || payload?.name || null,
      email: payload?.email || null,
      country: payload?.country || payload?.market || null,
      website: payload?.website || payload?.profileUrl || null,
      audienceEstimate: payload?.audienceEstimate || null,
      territory: payload?.territory || null,
      campaign: payload?.campaign || null
    };
  }
  return { keys: Object.keys(payload || {}).slice(0, 20) };
}

function classify(source, type, payload) {
  const normalizedType = String(type || '').toLowerCase();
  if (source === 'shopify' && (normalizedType.includes('order') || payload?.total_price)) return 'revenue';
  if (source === 'gmail') return 'lead_or_support';
  if (source === 'calendar') return 'appointment';
  if (source === 'ads') return 'marketing_performance';
  if (source === 'affiliate') return 'affiliate_lead';
  return 'general';
}

async function recordAffiliateLead(record) {
  const summary = record.summary;
  const business = {
    name: summary.organization || summary.email || 'Unknown affiliate applicant',
    website: summary.website || undefined,
    country: summary.country || undefined,
    relationshipType: 'affiliate_candidate',
    territory: summary.territory || undefined,
    audienceEstimate: summary.audienceEstimate || undefined,
    source: 'affiliate_application_form'
  };
  const contact = summary.email ? { email: summary.email } : null;
  const campaignId = summary.campaign || 'affiliate_applications';

  const { prospect, duplicate } = await prospectStore.create({ business, contact, campaignId }, 'integration-worker');
  if (!duplicate && prospect.stage === 'discovered') {
    await prospectStore.transition(prospect.prospectId, 'affiliate_applied', { eventId: record.eventId }, 'integration-worker');
  }
  return { prospectId: prospect.prospectId, duplicate, suppressed: prospect.status === 'suppressed' };
}

module.exports = { summarize, classify, recordAffiliateLead };

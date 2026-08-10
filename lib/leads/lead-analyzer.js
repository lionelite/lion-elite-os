'use strict';

/**
 * Analyses the gated-access leads captured by the Wellness storefront.
 *
 * The storefront's CustomerAccessGate collects name, email, phone and explicit
 * email/SMS marketing consent, upserts a row into `member_leads` with
 * status 'new' — and nothing in any codebase ever reads it again or updates
 * that status. Every person who opted in has been sitting untouched since the
 * gate went live.
 *
 * This module turns that table into an actionable, prioritised worklist and
 * quantifies what is being lost. Pure functions over plain rows: no database,
 * no network, so the classification rules are testable in isolation.
 *
 * It decides WHO may be contacted and on WHICH channel. It does not send.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deliberately loose: reject the obviously-broken, don't police valid addresses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** E.164, the only form the SMS rails accept. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

const AGE_BUCKETS = Object.freeze([
  { key: 'today', maxDays: 1 },
  { key: 'this_week', maxDays: 7 },
  { key: 'this_month', maxDays: 30 },
  { key: 'over_a_month', maxDays: Infinity },
]);

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';
const clean = (v) => String(v ?? '').trim();

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (E164_RE.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Raw `member_leads` row (or API payload) → canonical shape. */
function normalizeLead(row = {}) {
  const email = clean(row.email).toLowerCase();
  const createdAt = row.createdAt || row.created_at || row.submittedAt || null;
  return {
    id: row.id ?? email ?? null,
    name: clean(row.name),
    firstName: clean(row.name).split(/\s+/)[0] || '',
    email,
    phone: normalizePhone(row.phone),
    rawPhone: clean(row.phone),
    emailConsent: truthy(row.emailMarketingConsent ?? row.email_marketing_consent),
    smsConsent: truthy(row.smsMarketingConsent ?? row.sms_marketing_consent),
    emailConsentAt: row.emailConsentAt || row.email_consent_at || null,
    smsConsentAt: row.smsConsentAt || row.sms_consent_at || null,
    source: clean(row.source) || 'unknown',
    status: clean(row.status) || 'new',
    createdAt,
  };
}

function ageInDays(createdAt, now) {
  if (!createdAt) return null;
  const ts = new Date(createdAt).getTime();
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((now.getTime() - ts) / DAY_MS));
}

const bucketFor = (days) =>
  days === null ? 'unknown' : AGE_BUCKETS.find((b) => days < b.maxDays).key;

/**
 * Decide reachability per channel and record WHY when we cannot reach someone.
 *
 * Consent is the gate, and it is not a preference we can weigh against urgency:
 * emailing without opt-in is a CAN-SPAM problem and texting without prior
 * express written consent is a TCPA one. A lead who did not tick the box is
 * reported as blocked, never quietly upgraded.
 */
function assessLead(lead, { now = new Date(), suppressedEmails = new Set(), contactedEmails = new Set() } = {}) {
  const blockers = [];

  const hasValidEmail = EMAIL_RE.test(lead.email);
  if (!lead.email) blockers.push('no_email');
  else if (!hasValidEmail) blockers.push('invalid_email');
  if (!lead.emailConsent) blockers.push('no_email_consent');
  if (lead.email && suppressedEmails.has(lead.email)) blockers.push('suppressed');

  const emailReachable =
    hasValidEmail && lead.emailConsent && !suppressedEmails.has(lead.email);

  const smsBlockers = [];
  if (!lead.phone) smsBlockers.push(lead.rawPhone ? 'unparseable_phone' : 'no_phone');
  if (!lead.smsConsent) smsBlockers.push('no_sms_consent');
  const smsReachable = Boolean(lead.phone) && lead.smsConsent;

  const days = ageInDays(lead.createdAt, now);
  const alreadyContacted = lead.email ? contactedEmails.has(lead.email) : false;

  // Priority favours people who opted in and have been ignored longest — they
  // are the ones actively going cold. Multi-channel consent ranks higher
  // because there is a second way to land the message.
  let priority = 0;
  if (emailReachable) priority += 50;
  if (smsReachable) priority += 20;
  if (days !== null) priority += Math.min(30, days); // caps so a stale lead can't outrank a reachable fresh one
  if (alreadyContacted) priority -= 60;

  return {
    ...lead,
    ageDays: days,
    ageBucket: bucketFor(days),
    emailReachable,
    smsReachable,
    reachable: emailReachable || smsReachable,
    alreadyContacted,
    blockers,
    smsBlockers,
    priority,
    recommendedAction: !emailReachable && !smsReachable
      ? 'none_contactable'
      : alreadyContacted
        ? 'already_contacted'
        : emailReachable
          ? 'send_welcome_email'
          : 'sms_only_followup',
  };
}

function analyzeLeads(rows = [], options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const suppressedEmails = new Set(
    (options.suppressedEmails || []).map((e) => clean(e).toLowerCase())
  );
  const contactedEmails = new Set(
    (options.contactedEmails || []).map((e) => clean(e).toLowerCase())
  );

  const leads = rows
    .map(normalizeLead)
    .map((lead) => assessLead(lead, { now, suppressedEmails, contactedEmails }))
    .sort((a, b) => b.priority - a.priority);

  const actionable = leads.filter((l) => l.reachable && !l.alreadyContacted);
  const blocked = leads.filter((l) => !l.reachable);

  const byBlocker = {};
  for (const lead of blocked) {
    for (const code of new Set([...lead.blockers, ...lead.smsBlockers])) {
      byBlocker[code] = (byBlocker[code] || 0) + 1;
    }
  }

  const bySource = {};
  for (const lead of leads) {
    const s = (bySource[lead.source] ||= { total: 0, actionable: 0 });
    s.total += 1;
    if (lead.reachable && !lead.alreadyContacted) s.actionable += 1;
  }

  const byAge = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
  byAge.unknown = 0;
  for (const lead of leads) byAge[lead.ageBucket] += 1;

  const ages = leads.map((l) => l.ageDays).filter((d) => d !== null);

  return {
    generatedAt: now.toISOString(),
    total: leads.length,
    actionable: actionable.length,
    emailReachable: leads.filter((l) => l.emailReachable).length,
    smsReachable: leads.filter((l) => l.smsReachable).length,
    bothChannels: leads.filter((l) => l.emailReachable && l.smsReachable).length,
    alreadyContacted: leads.filter((l) => l.alreadyContacted).length,
    blocked: blocked.length,
    byBlocker,
    bySource,
    byAge,
    oldestLeadDays: ages.length ? Math.max(...ages) : null,
    // Untouched consented leads are the headline number: people who explicitly
    // asked to hear from us and never did.
    neverContactedConsented: actionable.length,
    leads,
    actionableLeads: actionable,
  };
}

/**
 * Rough value at risk. `averageOrderValue` and `expectedConversionRate` are
 * inputs, not guesses baked into the code — with no order history to derive
 * them from, an invented default would produce a confident fake number.
 */
function estimateValueAtRisk(analysis, { averageOrderValue = null, expectedConversionRate = null } = {}) {
  if (averageOrderValue === null || expectedConversionRate === null) {
    return { estimable: false, reason: 'averageOrderValue and expectedConversionRate are required' };
  }
  return {
    estimable: true,
    actionableLeads: analysis.actionable,
    averageOrderValue,
    expectedConversionRate,
    estimatedRevenue: Math.round(analysis.actionable * expectedConversionRate * averageOrderValue * 100) / 100,
  };
}

module.exports = {
  analyzeLeads,
  assessLead,
  normalizeLead,
  normalizePhone,
  estimateValueAtRisk,
  AGE_BUCKETS,
};

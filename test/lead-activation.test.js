'use strict';

/**
 * Gated-lead activation tests.
 *
 * The rules that matter here are the ones that decide whether a real person
 * gets contacted. Consent is a legal gate, not a preference, so the tests below
 * are written to fail loudly if urgency ever erodes it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeLeads, assessLead, normalizeLead, normalizePhone, estimateValueAtRisk } = require('../lib/leads/lead-analyzer');
const { buildWelcomeEmail } = require('../lib/outreach/campaign-emails');
const { getCampaign } = require('../lib/outreach/campaigns');

const NOW = new Date('2026-08-10T12:00:00.000Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

const row = (over = {}) => ({
  name: 'Test Person',
  email: 'person@example.com',
  phone: '+12165550100',
  email_marketing_consent: 1,
  sms_marketing_consent: 1,
  source: 'access_gate',
  status: 'new',
  created_at: daysAgo(5),
  ...over,
});

// ── consent is never inferred ───────────────────────────────────────────────

test('a lead without email consent is never email-reachable', () => {
  const [lead] = analyzeLeads([row({ email_marketing_consent: 0 })], { now: NOW }).leads;
  assert.equal(lead.emailReachable, false);
  assert.ok(lead.blockers.includes('no_email_consent'));
});

test('a lead without SMS consent is never SMS-reachable, even with a valid mobile', () => {
  const [lead] = analyzeLeads([row({ sms_marketing_consent: 0 })], { now: NOW }).leads;
  assert.equal(lead.smsReachable, false);
  assert.ok(lead.smsBlockers.includes('no_sms_consent'));
});

test('no consent on either channel means not contactable at all', () => {
  const analysis = analyzeLeads([row({ email_marketing_consent: 0, sms_marketing_consent: 0 })], { now: NOW });
  assert.equal(analysis.actionable, 0);
  assert.equal(analysis.blocked, 1);
  assert.equal(analysis.leads[0].recommendedAction, 'none_contactable');
});

test('age never promotes a non-consented lead into the worklist', () => {
  // Priority rises with age; it must never cross the consent gate.
  const analysis = analyzeLeads(
    [row({ email_marketing_consent: 0, sms_marketing_consent: 0, created_at: daysAgo(900) })],
    { now: NOW }
  );
  assert.equal(analysis.actionable, 0);
  assert.equal(analysis.actionableLeads.length, 0);
});

// ── contactability details ──────────────────────────────────────────────────

test('a suppressed address is excluded even with valid consent', () => {
  const analysis = analyzeLeads([row()], { now: NOW, suppressedEmails: ['person@example.com'] });
  assert.equal(analysis.leads[0].emailReachable, false);
  assert.ok(analysis.leads[0].blockers.includes('suppressed'));
});

test('suppression matching is case-insensitive', () => {
  const analysis = analyzeLeads([row({ email: 'Person@Example.com' })], {
    now: NOW,
    suppressedEmails: ['PERSON@EXAMPLE.COM'],
  });
  assert.equal(analysis.leads[0].emailReachable, false, 'casing must not defeat a suppression entry');
});

test('a malformed email is blocked rather than sent to', () => {
  const [lead] = analyzeLeads([row({ email: 'not-an-email' })], { now: NOW }).leads;
  assert.equal(lead.emailReachable, false);
  assert.ok(lead.blockers.includes('invalid_email'));
});

test('phone numbers are normalised to E.164, and junk is rejected', () => {
  assert.equal(normalizePhone('(216) 555-0142'), '+12165550142');
  assert.equal(normalizePhone('2165550142'), '+12165550142');
  assert.equal(normalizePhone('12165550142'), '+12165550142');
  assert.equal(normalizePhone('+12165550142'), '+12165550142');
  assert.equal(normalizePhone('216555'), null, 'a too-short number must not be guessed at');
  assert.equal(normalizePhone(''), null);
});

test('an unparseable phone is reported distinctly from a missing one', () => {
  const junk = analyzeLeads([row({ phone: '216555' })], { now: NOW }).leads[0];
  const none = analyzeLeads([row({ phone: '' })], { now: NOW }).leads[0];
  assert.ok(junk.smsBlockers.includes('unparseable_phone'));
  assert.ok(none.smsBlockers.includes('no_phone'));
});

test('already-contacted leads drop out of the worklist without being lost', () => {
  const analysis = analyzeLeads([row()], { now: NOW, contactedEmails: ['person@example.com'] });
  assert.equal(analysis.actionable, 0);
  assert.equal(analysis.alreadyContacted, 1);
  assert.equal(analysis.leads.length, 1, 'the lead is still reported, just not actionable');
  assert.equal(analysis.leads[0].recommendedAction, 'already_contacted');
});

// ── prioritisation ──────────────────────────────────────────────────────────

test('among reachable leads, the longest-ignored ranks first', () => {
  const analysis = analyzeLeads(
    [
      row({ email: 'fresh@example.com', created_at: daysAgo(1) }),
      row({ email: 'stale@example.com', created_at: daysAgo(40) }),
    ],
    { now: NOW }
  );
  assert.equal(analysis.actionableLeads[0].email, 'stale@example.com');
});

test('a reachable lead outranks an unreachable one no matter how old', () => {
  const analysis = analyzeLeads(
    [
      row({ email: 'ancient@example.com', email_marketing_consent: 0, sms_marketing_consent: 0, created_at: daysAgo(999) }),
      row({ email: 'reachable@example.com', created_at: daysAgo(0) }),
    ],
    { now: NOW }
  );
  assert.equal(analysis.leads[0].email, 'reachable@example.com');
});

// ── aggregate reporting ─────────────────────────────────────────────────────

test('the summary counts channels, blockers and the oldest wait', () => {
  const analysis = analyzeLeads(
    [
      row({ email: 'both@example.com', created_at: daysAgo(30) }),
      row({ email: 'emailonly@example.com', sms_marketing_consent: 0 }),
      row({ email: 'smsonly@example.com', email_marketing_consent: 0 }),
      row({ email: 'neither@example.com', email_marketing_consent: 0, sms_marketing_consent: 0 }),
    ],
    { now: NOW }
  );

  assert.equal(analysis.total, 4);
  assert.equal(analysis.emailReachable, 2);
  assert.equal(analysis.smsReachable, 2);
  assert.equal(analysis.bothChannels, 1);
  assert.equal(analysis.actionable, 3);
  assert.equal(analysis.blocked, 1);
  assert.equal(analysis.oldestLeadDays, 30);
  assert.equal(analysis.neverContactedConsented, 3);
});

test('value at risk refuses to invent numbers it was not given', () => {
  const analysis = analyzeLeads([row()], { now: NOW });
  assert.equal(estimateValueAtRisk(analysis, {}).estimable, false);

  const estimate = estimateValueAtRisk(analysis, { averageOrderValue: 100, expectedConversionRate: 0.1 });
  assert.equal(estimate.estimable, true);
  assert.equal(estimate.estimatedRevenue, 10);
});

test('normalizeLead reads both snake_case rows and camelCase payloads', () => {
  const snake = normalizeLead({ email: 'A@B.com', email_marketing_consent: 1, created_at: daysAgo(1) });
  const camel = normalizeLead({ email: 'A@B.com', emailMarketingConsent: true, createdAt: daysAgo(1) });
  assert.equal(snake.email, 'a@b.com', 'email is lowercased for reliable matching');
  assert.equal(snake.emailConsent, true);
  assert.equal(camel.emailConsent, true);
});

// ── the outbound message ────────────────────────────────────────────────────

test('the welcome campaign cannot skip its consumer safeguards', () => {
  const campaign = getCampaign('gated_lead_welcome');
  assert.equal(campaign.audienceType, 'consumer');
  assert.equal(campaign.complianceMode, 'research-only');
  for (const key of ['complianceValidation', 'suppressionCheck', 'dailyQuota', 'killSwitch', 'unsubscribe', 'postalAddress']) {
    assert.equal(campaign.safeguards[key], true, `${key} must be enforced`);
  }
  assert.equal(campaign.requiresExplicitOptIn, true);
});

test('the welcome email refuses to build without CAN-SPAM essentials', () => {
  assert.throws(() => buildWelcomeEmail({ firstName: 'Jordan', postalAddress: 'x' }), /unsubscribe/i);
  assert.throws(() => buildWelcomeEmail({ firstName: 'Jordan', unsubscribeUrl: 'https://x/u' }), /postal address/i);
});

test('the welcome email passes RUO compliance and carries the disclaimer', () => {
  const draft = buildWelcomeEmail({
    firstName: 'Jordan',
    unsubscribeUrl: 'https://lionelitewellness.com/unsubscribe',
    postalAddress: 'Lion Elite Wellness, PO Box 1234, Cleveland, OH 44101',
  });

  assert.equal(draft.approved, true);
  assert.deepEqual(draft.compliance.blockers, []);
  assert.match(draft.body, /laboratory research purposes only/i);
  assert.match(draft.body, /unsubscribe/i);
  assert.match(draft.body, /PO Box 1234/);
  assert.equal(draft.campaignId, 'gated_lead_welcome');
});

test('human-use language injected through the name is caught by the validator', () => {
  // The builder is the choke point; nothing reaches a customer unvalidated.
  const draft = buildWelcomeEmail({
    firstName: 'take 5mg weekly for weight loss and inject subcutaneously',
    unsubscribeUrl: 'https://lionelitewellness.com/unsubscribe',
    postalAddress: 'Lion Elite Wellness, PO Box 1234, Cleveland, OH 44101',
  });
  assert.equal(draft.approved, false, 'dosing/administration language must block the send');
  assert.ok(draft.compliance.blockers.length > 0);
});

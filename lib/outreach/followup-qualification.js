'use strict';

/**
 * Qualification for the ONE follow-up to clinics already contacted (stage
 * `contacted`: the October sends that happened outside this pipeline, recorded
 * in `enrichment.historical_sends` / `enrichment.last_sent`).
 *
 * Same rule as lib/outreach/clinic-qualification.js: every status the 16-check
 * engine reads is derived from evidence, and missing evidence is the failing
 * value. The engine's thresholds are not touched.
 *
 * Differences from the first-touch qualifier, each for a stated reason:
 *   - Eligibility requires stage `contacted` and a targeting tier other than
 *     `exclude`. These records were picked by a person and already e-mailed;
 *     requiring tier `high` would drop clinics a human already chose, while
 *     `exclude` (hospital systems, paediatrics, etc.) still never gets mail.
 *   - Freshness is a live MX lookup on the inbox domain, done by the caller
 *     immediately before qualification. The import date is not evidence that an
 *     address still works; a domain that accepts mail today is.
 *   - Cadence: at most one automated follow-up per prospect (enforced again by
 *     the per-prospect/campaign/step idempotency key), and none within
 *     FOLLOWUP_MIN_GAP_DAYS of the last recorded send.
 *   - Frequency: October sends inside the 30-day window count against the
 *     engine's 3-per-window limit, so a clinic e-mailed three times recently
 *     waits until the window clears rather than receiving a fourth.
 */

const { normalizeDomain, scoreQualification } = require('../outreach-validation');
const { clinicRelevance } = require('../contacts/clinic-targeting');
const { CLINIC_POLICY, FREE_MAIL } = require('./clinic-qualification');
const { buildClinicFollowUpEmail, FOLLOWUP_STEP_ID } = require('./clinic-followup-email');
const { isApprovedVersion } = require('./approved-message-versions');
const { neverEmailReason } = require('./never-email');

const FOLLOWUP_MIN_GAP_DAYS = 14;
const FREQUENCY_WINDOW_DAYS = 30;
const STOP_STAGES = Object.freeze(['suppressed', 'replied', 'disqualified', 'engaged', 'meeting_booked', 'customer', 'opportunity']);
const STOP_STATUSES = Object.freeze(['held', 'suppressed']);

const truthy = v => v === true || String(v).toLowerCase() === 'true';

function emailDomain(email) {
  const at = String(email || '').toLowerCase().trim().split('@');
  return at.length === 2 ? at[1] : '';
}

function sameOrganisation(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Flags set on the record itself (imported from the old CRM) that mean "do not contact". */
function recordStopFlags(prospect = {}) {
  const b = prospect.business || {};
  const c = prospect.contact || {};
  const flags = [];
  if (truthy(b.do_not_contact) || truthy(c.do_not_contact)) flags.push('do_not_contact');
  if (truthy(b.suppressed) || truthy(c.suppressed)) flags.push('suppressed flag');
  if (STOP_STATUSES.includes(prospect.status)) flags.push(`status ${prospect.status}`);
  if (STOP_STAGES.includes(prospect.stage)) flags.push(`stage ${prospect.stage}`);
  return flags;
}

/**
 * @param facts {
 *   suppression, priorFollowUps, recentQueueSends, domainFollowedUpElsewhere,
 *   mx: { ok, checkedAt, detail }
 * }
 */
function qualifyFollowUp(prospect = {}, facts = {}, { now = new Date(), env = process.env } = {}) {
  const business = prospect.business || {};
  const contact = prospect.contact || {};
  const enrichment = prospect.enrichment || {};
  const email = String(contact.email || '').trim().toLowerCase();
  const site = business.website || business.domain || '';
  const siteDomain = normalizeDomain(site);
  const mailDomain = emailDomain(email);
  const nowMs = new Date(now).getTime();
  const checks = {};
  const record = (name, value, passed, evidence) => { checks[name] = { value, passed, evidence }; return value; };

  // Never-email list first: it overrides everything.
  const never = neverEmailReason(email, env);
  record('neverEmail', never ? 'blocked' : 'clear', !never, never || 'Not on the never-email list.');

  const source = site && sameOrganisation(mailDomain, siteDomain)
    ? { type: 'public_website', url: /^https?:\/\//.test(site) ? site : `https://${siteDomain}`, approved: true }
    : {};
  record('source', source.type || null, Boolean(source.type), source.type
    ? `Inbox domain matches the business's own site (${source.url}).`
    : `No verifiable origin: inbox ${mailDomain || '(none)'} vs site ${siteDomain || '(none)'}.`);

  const freeMail = FREE_MAIL.includes(mailDomain);
  const identityVerified = Boolean(email) && !freeMail && sameOrganisation(mailDomain, siteDomain);
  record('identity', identityVerified ? 'verified' : 'unverified', identityVerified, !email
    ? 'No e-mail address.'
    : freeMail ? `Personal mailbox (${mailDomain}), not a business inbox.`
      : identityVerified ? `Inbox domain ${mailDomain} matches ${siteDomain}.` : `Inbox domain ${mailDomain} does not match ${siteDomain || '(no site)'}.`);

  const dupes = Number(facts.domainFollowedUpElsewhere || 0);
  record('duplicate', dupes === 0 ? 'clear' : 'duplicate', dupes === 0, dupes === 0
    ? 'No other record at this organisation has had the follow-up.'
    : `${dupes} other record(s) at ${mailDomain} already received the follow-up.`);

  const relevance = clinicRelevance({ name: business.name, website: site, category: business.niche || business.category });
  const stopFlags = recordStopFlags(prospect);
  const eligible = prospect.stage === 'contacted' && relevance.tier !== 'exclude' && stopFlags.length === 0;
  record('eligibility', eligible ? 'eligible' : 'ineligible', eligible, prospect.stage !== 'contacted'
    ? `Stage is ${prospect.stage}, not contacted.`
    : stopFlags.length ? `Stopped: ${stopFlags.join(', ')}.`
      : relevance.tier === 'exclude' ? `Excluded by targeting: ${relevance.reasons.join(' ')}` : `Targeting tier ${relevance.tier}.`);

  const suppressed = Boolean(facts.suppression) || stopFlags.length > 0;
  record('suppression', suppressed ? 'suppressed' : 'clear', !suppressed, facts.suppression
    ? `On the opt-out list (${facts.suppression.reason}: ${facts.suppression.address || facts.suppression.domain}).`
    : stopFlags.length ? `Record flags: ${stopFlags.join(', ')}.` : 'Not on the opt-out list.');

  const mx = facts.mx || {};
  const verifiedAt = mx.ok ? (mx.checkedAt || new Date(now).toISOString()) : null;
  record('verifiedAt', verifiedAt, Boolean(verifiedAt), mx.ok ? `${mailDomain} accepts mail (MX checked ${verifiedAt}).` : `Inbox domain not verified: ${mx.detail || 'no MX lookup'}.`);

  let draft = null;
  try {
    draft = buildClinicFollowUpEmail({
      businessName: business.displayName || business.name,
      contactName: contact.first_name || contact.name || null,
      category: business.niche || business.category,
      whyTargeted: relevance.reasons.join(' '),
    });
  } catch (error) {
    record('draft', null, false, error.message);
  }
  const qualityScore = draft ? draft.quality.score : 0;
  const wordsOk = draft ? draft.messageWordCount >= 60 && draft.messageWordCount <= 90 : false;
  record('personalization', qualityScore, Boolean(draft && draft.quality.blockers.length === 0 && wordsOk), draft
    ? `Draft quality ${qualityScore}/100, ${draft.messageWordCount} words.` : 'No draft could be built.');
  const compliant = Boolean(draft && draft.approved && draft.quality.blockers.length === 0);
  record('compliance', compliant ? 'passed' : 'failed', compliant, compliant ? 'Passed the RUO compliance check.' : 'Failed the RUO compliance check.');

  // Cadence: one automated follow-up, and not too soon after the last send.
  const lastSent = enrichment.last_sent ? new Date(enrichment.last_sent).getTime() : null;
  const daysSince = lastSent ? (nowMs - lastSent) / 86_400_000 : null;
  const priorFollowUps = Number(facts.priorFollowUps || 0);
  const cadenceOk = priorFollowUps === 0 && (daysSince === null || daysSince >= FOLLOWUP_MIN_GAP_DAYS);
  record('cadence', cadenceOk ? 'allowed' : 'blocked', cadenceOk, priorFollowUps
    ? 'Follow-up already sent; the automated sequence is one message.'
    : daysSince !== null && daysSince < FOLLOWUP_MIN_GAP_DAYS ? `Last e-mailed ${Math.floor(daysSince)} day(s) ago; minimum gap is ${FOLLOWUP_MIN_GAP_DAYS}.`
      : 'Due for the follow-up.');

  // Frequency window: historical sends count if the last one is inside the window.
  const historical = Number(enrichment.historical_sends || 0);
  const historicalInWindow = daysSince !== null && daysSince < FREQUENCY_WINDOW_DAYS ? historical : 0;
  const contactCountInWindow = historicalInWindow + Number(facts.recentQueueSends || 0);
  record('frequency', contactCountInWindow, contactCountInWindow < 3, `${contactCountInWindow} send(s) in the last ${FREQUENCY_WINDOW_DAYS} days (limit 3).`);

  const versionApproved = Boolean(draft && isApprovedVersion(draft.messageVersion, env));
  record('messageVersion', draft ? draft.messageVersion : null, versionApproved, versionApproved
    ? `${draft.messageVersion} is owner-approved.`
    : `${draft ? draft.messageVersion : '(none)'} is not in OUTREACH_APPROVED_MESSAGE_VERSIONS.`);

  const score = scoreQualification({
    overallFit: { high: 1, medium: 0.7, low: 0.3 }[relevance.tier] || 0,
    buyingPotential: draft ? ({ med_spa: 0.8, longevity: 0.8, iv_hydration: 0.8, wellness: 0.7, plastic_surgery: 0.6, dermatology: 0.6 }[draft.personalization.segment] || 0.5) : 0,
    timingIndicators: 0.5,
    strategicValue: 0.5,
    dataConfidence: identityVerified ? 1 : 0.3,
    personalizationReadiness: qualityScore / 100,
  });

  const view = {
    ...prospect,
    id: prospect.prospectId,
    campaignId: prospect.campaignId,
    business: { ...business, name: business.name || business.displayName, domain: siteDomain || business.domain },
    source,
    identityStatus: checks.identity.value,
    identityConfidence: identityVerified ? 0.95 : 0.3,
    duplicateStatus: checks.duplicate.value,
    campaignEligibility: checks.eligibility.value,
    state: prospect.stage,
    suppressionStatus: checks.suppression.value === 'clear' && !never ? 'clear' : 'suppressed',
    optOut: suppressed || Boolean(never),
    lastVerifiedAt: verifiedAt,
    qualificationScore: score,
    personalization: { qualityScore, evidenceCoverage: draft ? 1 : 0 },
    crmSyncStatus: prospect.prospectId ? 'synced' : 'unsynced',
    cadenceStatus: checks.cadence.value,
    channel: 'email',
    complianceStatus: checks.compliance.value,
    contactCountInWindow,
    sequenceStepId: FOLLOWUP_STEP_ID,
    messageVersion: draft ? draft.messageVersion : null,
    messageVersionStatus: versionApproved ? 'approved' : 'unapproved',
  };

  const blockers = Object.entries(checks).filter(([, c]) => !c.passed).map(([name, c]) => `${name}: ${c.evidence}`);
  return {
    qualified: blockers.length === 0,
    view,
    policy: CLINIC_POLICY,
    draft: draft ? { ...draft, recipient: email, channel: 'email' } : null,
    checks,
    blockers,
    tier: relevance.tier,
  };
}

module.exports = { qualifyFollowUp, recordStopFlags, FOLLOWUP_MIN_GAP_DAYS, FREQUENCY_WINDOW_DAYS, STOP_STAGES, STOP_STATUSES };

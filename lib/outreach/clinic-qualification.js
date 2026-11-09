'use strict';

/**
 * Qualification for the med_spa_research_supply campaign: the step between
 * discovery and the 16-check validation engine.
 *
 * Why it exists: lib/outreach-validation.js reads a set of status fields off a
 * prospect (identityStatus, duplicateStatus, campaignEligibility,
 * suppressionStatus, qualificationScore, personalization, cadenceStatus,
 * complianceStatus, messageVersionStatus, ...). They were meant to be set by
 * research/qualification/personalization workers that were never built, so a
 * discovered clinic carried none of them and failed 15 of 16 checks. Nothing
 * could ever be sent.
 *
 * The rule this module follows: every status is DERIVED FROM EVIDENCE in the
 * record or from a database fact, and each one returns the evidence it used. No
 * status is set to its passing value because a pass is wanted. Where the
 * evidence is missing the status is the failing one, and the validation engine
 * then blocks the send exactly as before. The engine's thresholds are untouched.
 *
 * Pure: database facts are passed in (see PostgresProspectStore.contactFacts),
 * so every decision is unit-testable.
 */

const { normalizeDomain, scoreQualification } = require('../outreach-validation');
const { clinicRelevance } = require('../contacts/clinic-targeting');
const { CAMPAIGN_ID, buildClinicSupplyEmail } = require('./clinic-supply-email');
const { isApprovedVersion } = require('./approved-message-versions');

/** Policy handed to the validation engine for this campaign. Engine defaults otherwise. */
const CLINIC_POLICY = Object.freeze({ approvedChannels: Object.freeze(['email']) });

const FREE_MAIL = Object.freeze([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'att.net', 'protonmail.com', 'proton.me',
]);

const SEGMENT_BUYING_POTENTIAL = Object.freeze({
  med_spa: 0.8, longevity: 0.8, iv_hydration: 0.8, wellness: 0.7, plastic_surgery: 0.6, dermatology: 0.6, clinic: 0.5,
});

function emailDomain(email) {
  const at = String(email || '').toLowerCase().trim().split('@');
  return at.length === 2 ? at[1] : '';
}

function sameOrganisation(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function osmUrl(sourceRef) {
  const m = String(sourceRef || '').match(/^osm:(node|way|relation)\/(\d+)$/);
  return m ? `https://www.openstreetmap.org/${m[1]}/${m[2]}` : '';
}

/**
 * @param prospect stored prospect (lib/postgres-prospect-store.js mapProspect shape)
 * @param facts {
 *   suppression: { address|domain, reason } | null   — address/domain opt-out list
 *   priorQueueCount: number                          — outreach_queue rows for this prospect
 *   domainContactedElsewhere: number                 — other prospects at this domain already queued/sent
 * }
 * @returns { qualified, view, policy, draft, checks, blockers }
 *   view   — the prospect with the status fields the validation engine reads
 *   checks — per status: { value, passed, evidence }
 */
function qualifyClinicProspect(prospect = {}, facts = {}, { now = new Date(), env = process.env } = {}) {
  const business = prospect.business || {};
  const contact = prospect.contact || {};
  const email = String(contact.email || '').trim().toLowerCase();
  const siteDomain = normalizeDomain(business.website || business.domain || '');
  const mailDomain = emailDomain(email);
  const checks = {};
  const record = (name, value, passed, evidence) => { checks[name] = { value, passed, evidence }; return value; };

  // Source: where the business record came from.
  const directoryUrl = osmUrl(business.sourceRef);
  const source = directoryUrl
    ? { type: 'public_directory', url: directoryUrl, approved: true }
    : business.website && sameOrganisation(mailDomain, siteDomain)
      ? { type: 'public_website', url: business.website, approved: true }
      : {};
  record('source', source.type || null, Boolean(source.type), source.type
    ? `Business record from ${source.type === 'public_directory' ? 'OpenStreetMap' : 'its own website'} (${source.url}).`
    : 'No recorded origin for this business.');

  // Identity: is this inbox the business's own?
  const freeMail = FREE_MAIL.includes(mailDomain);
  const identityVerified = Boolean(email) && !freeMail && sameOrganisation(mailDomain, siteDomain);
  record('identity', identityVerified ? 'verified' : 'unverified', identityVerified, !email
    ? 'No e-mail address.'
    : freeMail
      ? `Personal mailbox (${mailDomain}), not a business inbox.`
      : identityVerified
        ? `Inbox domain ${mailDomain} matches the business website ${siteDomain}.`
        : `Inbox domain ${mailDomain || '?'} does not match the website ${siteDomain || '(none)'}.`);

  // Duplicate: has this organisation already been approached through another record?
  const domainContacted = Number(facts.domainContactedElsewhere || 0);
  record('duplicate', domainContacted === 0 ? 'clear' : 'duplicate', domainContacted === 0, domainContacted === 0
    ? 'No other prospect at this domain has been queued or sent.'
    : `${domainContacted} other prospect(s) at ${mailDomain} already queued or sent.`);

  // Eligibility: only clinics the targeting rules rate HIGH go out unattended.
  // `medium` reads "check the site before sending" (lib/contacts/clinic-targeting.js),
  // which needs a person, so it is not eligible for automatic sends.
  const relevance = clinicRelevance({ name: business.name, website: business.website, category: business.niche || business.category });
  const terminal = ['suppressed', 'disqualified', 'closed'].includes(prospect.stage);
  const eligible = relevance.tier === 'high' && !terminal;
  record('eligibility', eligible ? 'eligible' : 'ineligible', eligible, terminal
    ? `Prospect stage is ${prospect.stage}.`
    : `Targeting tier ${relevance.tier}: ${relevance.reasons.join(' ')}${relevance.tier === 'medium' ? ' Medium-tier clinics need a person to check the site first.' : ''}`);

  // Suppression: per-prospect status and the address/domain opt-out list.
  const suppressed = prospect.status === 'suppressed' || Boolean(facts.suppression);
  record('suppression', suppressed ? 'suppressed' : 'clear', !suppressed, suppressed
    ? `Suppressed (${facts.suppression ? `${facts.suppression.reason}: ${facts.suppression.address || facts.suppression.domain}` : 'prospect status'}).`
    : 'Not on the opt-out list and not suppressed.');

  // Freshness: when the contact was last confirmed. Discovery finds and enriches
  // in one pass, so that is the record's enrichment time, else its creation time.
  const verifiedAt = (prospect.enrichment && prospect.enrichment.verifiedAt) || prospect.createdAt || null;
  record('verifiedAt', verifiedAt, Boolean(verifiedAt), verifiedAt ? `Contact last confirmed ${new Date(verifiedAt).toISOString().slice(0, 10)}.` : 'Never confirmed.');

  // Personalization: build the draft first; its own checklist scores it.
  let draft = null;
  try {
    draft = buildClinicSupplyEmail({
      businessName: business.displayName || business.name,
      contactName: contact.name,
      category: business.niche || business.category,
      whyTargeted: relevance.reasons.join(' '),
      market: business.region,
    }, { step: 1 });
  } catch (error) {
    record('draft', null, false, error.message);
  }
  // Evidence coverage: each personal detail the e-mail states must come from the record.
  const claims = draft ? [
    ['business name', Boolean(business.displayName || business.name)],
    ['practice type', draft.personalization.segment !== 'clinic' ? Boolean(business.niche || business.name) : true],
    ['city', draft.personalization.city ? Boolean(business.region) : true],
    ['contact name', draft.personalization.contactName ? Boolean(contact.name) : true],
  ] : [];
  const sourced = claims.filter(([, ok]) => ok).length;
  const coverage = claims.length ? sourced / claims.length : 0;
  const qualityScore = draft ? draft.quality.score : 0;
  record('personalization', qualityScore, draft ? draft.quality.blockers.length === 0 : false, draft
    ? `Draft quality ${qualityScore}/100; ${sourced}/${claims.length} personal details come from the record.`
    : 'No draft could be built.');

  // Compliance: the RUO validator on the exact copy that would be sent.
  const compliant = Boolean(draft && draft.approved && draft.quality.blockers.length === 0);
  record('compliance', compliant ? 'passed' : 'failed', compliant, draft
    ? (compliant ? 'Passed the research-use-only compliance check.' : `Blocked: ${[...draft.quality.blockers].join(', ')}.`)
    : 'No draft.');

  // Cadence: this campaign only ever sends a first touch automatically. Follow-ups
  // need reply detection, which does not exist yet, so a prospect that has ever
  // been queued is not contacted again by this path.
  const priorQueue = Number(facts.priorQueueCount || 0);
  record('cadence', priorQueue === 0 ? 'allowed' : 'blocked', priorQueue === 0, priorQueue === 0
    ? 'Never contacted by this pipeline.'
    : `Already queued ${priorQueue} time(s); follow-ups are not automated without reply detection.`);

  // Message version: the owner's approval, from OUTREACH_APPROVED_MESSAGE_VERSIONS.
  const versionApproved = Boolean(draft && isApprovedVersion(draft.messageVersion, env));
  record('messageVersion', draft ? draft.messageVersion : null, versionApproved, versionApproved
    ? `${draft.messageVersion} is owner-approved.`
    : `${draft ? draft.messageVersion : '(none)'} is not in OUTREACH_APPROVED_MESSAGE_VERSIONS. The owner approves a version there.`);

  // Qualification score, from the evidence above. Inputs are documented so the
  // number can be argued with: fit is the targeting tier, buying potential the
  // practice type, data confidence the identity check, readiness the draft score.
  // Timing and strategic value are unknown for a cold record and count as half.
  const score = scoreQualification({
    overallFit: { high: 1, medium: 0.7, low: 0.3 }[relevance.tier] || 0,
    buyingPotential: draft ? SEGMENT_BUYING_POTENTIAL[draft.personalization.segment] || 0.5 : 0,
    timingIndicators: 0.5,
    strategicValue: 0.5,
    dataConfidence: identityVerified ? 1 : 0.3,
    personalizationReadiness: qualityScore / 100,
  });

  const view = {
    ...prospect,
    // The validation engine and authorizeOutreach key on `id`.
    id: prospect.prospectId,
    campaignId: prospect.campaignId,
    business: { ...business, domain: siteDomain || business.domain },
    source,
    identityStatus: checks.identity.value,
    identityConfidence: identityVerified ? 0.95 : 0.3,
    duplicateStatus: checks.duplicate.value,
    campaignEligibility: checks.eligibility.value,
    state: prospect.stage,
    suppressionStatus: checks.suppression.value,
    optOut: suppressed,
    lastVerifiedAt: verifiedAt,
    qualificationScore: score,
    personalization: { ...(prospect.personalization || {}), qualityScore, evidenceCoverage: coverage, whyTargeted: relevance.reasons.join(' ') },
    // The prospects table is the system of record; this view was read from it.
    crmSyncStatus: prospect.prospectId ? 'synced' : 'unsynced',
    cadenceStatus: checks.cadence.value,
    channel: 'email',
    complianceStatus: checks.compliance.value,
    contactCountInWindow: priorQueue,
    sequenceStepId: 'step1',
    messageVersion: draft ? draft.messageVersion : null,
    messageVersionStatus: versionApproved ? 'approved' : 'unapproved',
  };

  const blockers = Object.entries(checks).filter(([, c]) => !c.passed).map(([name, c]) => `${name}: ${c.evidence}`);
  return {
    qualified: blockers.length === 0,
    campaignId: CAMPAIGN_ID,
    view,
    policy: CLINIC_POLICY,
    draft: draft ? { ...draft, recipient: email, channel: 'email' } : null,
    checks,
    blockers,
    tier: relevance.tier,
  };
}

module.exports = { qualifyClinicProspect, CLINIC_POLICY, FREE_MAIL };

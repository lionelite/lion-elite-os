'use strict';

// Legal entity registry.
//
// Lion Elite Wellness sells Research-Use-Only material to research buyers. The
// clinic-supply LLC (in formation, 2026-09-15) is a separate legal entity with
// a different customer, a different posture, and — this is the part that has to
// be real in the data rather than in anyone's head — a different set of things
// it is allowed to say.
//
// Two entities sharing one prospect table, one suppression list, and one
// from-address are not two entities. They are one entity with two logos, and
// the first time a lead acquired under an RUO research pitch receives a
// clinical supply e-mail, the separation was never real. This module makes the
// boundary enforceable:
//
//   - every campaign declares the entity it sends as, and its compliance mode
//     must match that entity's posture;
//   - every prospect records the entity that acquired it, and may not be mailed
//     by another;
//   - consent is scoped to the entity it was given to;
//   - each entity sends from its own address, because that is the only place
//     the recipient can see which company is writing;
//   - an entity that is still forming cannot send at all, and cannot hold a
//     release record.
//
// Fails closed throughout, like the rest of this repo. Nothing here invents a
// legal name, a formation state, or a registration number — an entity stays
// `forming`, and therefore inert, until the owner enters the real values.
//
// Not legal advice. Entity structure and the posture assigned to each entity
// should be confirmed by counsel.

const { SUPPORTED_COMPLIANCE_MODES } = require('../social/social-compliance');

const POSTURES = Object.freeze([
  'ruo_research_supply',    // research chemicals sold to research buyers
  'api_for_compounding',    // bulk drug substance sold into 503A/503B compounding
  'cosmetics_and_coaching'  // MoCRA cosmetics + clinician-delegated coaching services
]);
const STATUSES = Object.freeze(['forming', 'active', 'dormant']);

/** Every entity needs a legal name before it can put one on an e-mail. */
const ACTIVATION_FIELDS = Object.freeze(['legalName']);

// A drug supplier's own registration details are load-bearing in a way a
// research supplier's are not: a compounding pharmacy's vendor qualification
// asks who it is buying from. So these are required on top, for that posture
// only, rather than imposed on an entity that does not need them to send.
const API_POSTURE_ACTIVATION_FIELDS = Object.freeze(['formationState', 'registeredAddress']);

function isFilled(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

/**
 * Structural validation, run at registration time so a malformed entity is a
 * startup failure rather than a surprise at send time.
 */
function assertEntityShape(entity) {
  const problems = [];

  if (!isFilled(entity.id)) problems.push('id is required');
  if (!POSTURES.includes(entity.posture)) problems.push(`posture must be one of ${POSTURES.join(', ')}`);
  if (!STATUSES.includes(entity.status)) problems.push(`status must be one of ${STATUSES.join(', ')}`);
  if (!isFilled(entity.complianceMode)) problems.push('complianceMode is required');
  if (!Array.isArray(entity.customerTypes) || entity.customerTypes.length === 0) {
    problems.push('customerTypes must list who this entity is permitted to sell to');
  }

  // A2P 10DLC brand registration is tied to a legal entity's EIN, so two
  // entities cannot lawfully share an origination number even if it would be
  // convenient. SMS origination is part of an entity's identity, not a shared
  // account setting.
  for (const key of ['fromEnvVar', 'postalAddressEnvVar', 'unsubscribeEnvVar', 'smsFromEnvVar']) {
    if (!isFilled(entity.sending?.[key])) problems.push(`sending.${key} is required`);
  }

  // The RUO posture is the one the compliance validator is built around. An
  // entity claiming that posture under any other mode would send RUO-labelled
  // material through a gate that does not check RUO language.
  if (entity.posture === 'ruo_research_supply' && entity.complianceMode !== 'research-only') {
    problems.push("posture ruo_research_supply requires complianceMode 'research-only'");
  }
  // Same pinning for the consumer posture: cosmetics and coaching copy is
  // gated by the coaching ruleset, which blocks medical claims, guarantees and
  // outcome promises, and keeps research compounds off the consumer brand.
  if (entity.posture === 'cosmetics_and_coaching' && entity.complianceMode !== 'coaching') {
    problems.push("posture cosmetics_and_coaching requires complianceMode 'coaching'");
  }

  // An active entity's compliance mode must have rules behind it. Without
  // them every piece of its copy lands in validateContent's fail-closed
  // unknown-mode branch — safe, but it looks like a bug rather than a decision.
  // Declaring an unimplemented mode is allowed while an entity is still
  // forming, precisely so the gap is recorded and enforced rather than
  // discovered on the first send.
  if (entity.status === 'active' && !SUPPORTED_COMPLIANCE_MODES.includes(entity.complianceMode)) {
    problems.push(
      `complianceMode "${entity.complianceMode}" has no rules in lib/social/social-compliance.js `
      + `(implemented: ${SUPPORTED_COMPLIANCE_MODES.join(', ')}) and cannot be used by an active entity`
    );
  }

  if (problems.length) {
    throw new Error(`Entity "${entity.id || '(unnamed)'}" is not registrable: ${problems.join('; ')}`);
  }
  return Object.freeze({ ...entity, sending: Object.freeze({ ...entity.sending }) });
}

const ENTITIES = Object.freeze({
  lion_elite_wellness: assertEntityShape({
    id: 'lion_elite_wellness',
    legalName: 'Lion Elite Wellness',
    formationState: '',
    registeredAddress: '',
    status: 'active',
    posture: 'ruo_research_supply',
    brand: 'wellness',
    complianceMode: 'research-only',
    customerTypes: Object.freeze(['research_buyer']),
    sending: {
      fromEnvVar: 'OUTREACH_FROM_EMAIL',
      replyToEnvVar: 'OUTREACH_REPLY_TO',
      postalAddressEnvVar: 'OUTREACH_POSTAL_ADDRESS',
      unsubscribeEnvVar: 'OUTREACH_UNSUBSCRIBE_EMAIL',
      // The existing shared Twilio number, so Wellness SMS behaviour is unchanged.
      smsFromEnvVar: 'TWILIO_FROM_NUMBER',
      signature: Object.freeze({
        name: 'Alexander Ringfield',
        brand: 'Lion Elite Wellness',
        website: 'https://lionelitewellness.com'
      })
    }
  }),

  // Lion Elite Beauty — a separate legal entity (owner, 2026-09-18), operating
  // today. Cosmetics under MoCRA plus clinician-delegated coaching services,
  // both gated by the coaching ruleset (credentials/README.md describes the two
  // record types: the skincare dossier and the protocol credential).
  //
  // Its own sending identity throughout. It has no e-mail campaign yet, so the
  // BEAUTY_* address vars are unset and describeSendability says so — that is
  // accurate rather than a gap. Its SMS campaign (coaching_welcome_sms) needs a
  // Beauty-registered origination number before it can send.
  lion_elite_beauty: assertEntityShape({
    id: 'lion_elite_beauty',
    legalName: 'Lion Elite Beauty',
    formationState: '',
    registeredAddress: '',
    status: 'active',
    posture: 'cosmetics_and_coaching',
    brand: 'beauty',
    complianceMode: 'coaching',
    customerTypes: Object.freeze(['consumer']),
    sending: {
      fromEnvVar: 'BEAUTY_FROM_EMAIL',
      replyToEnvVar: 'BEAUTY_REPLY_TO',
      postalAddressEnvVar: 'BEAUTY_POSTAL_ADDRESS',
      unsubscribeEnvVar: 'BEAUTY_UNSUBSCRIBE_EMAIL',
      smsFromEnvVar: 'BEAUTY_TWILIO_FROM_NUMBER',
      signature: Object.freeze({
        name: 'Alexander Ringfield',
        brand: 'Lion Elite Beauty',
        website: 'https://lionelitebeauty.com'
      })
    }
  }),

  // In formation as of 2026-09-15. Clinics and med spas only, US-based sources
  // only, supply into 503A/503B compounding.
  //
  // DELIBERATELY INERT. `legalName`, `formationState` and `registeredAddress`
  // are empty and `status` is 'forming', so `assertSendable` refuses every send
  // and `assertPostureMatch` refuses every release record under it. Those are
  // facts about a company that exists, and they get entered when it does — not
  // guessed at here. Flipping status to 'active' is an owner action, and it is
  // the same shape of decision as OUTREACH_SEND_ENABLED: the switch belongs to
  // the owner, not to this file.
  clinic_supply_llc: assertEntityShape({
    id: 'clinic_supply_llc',
    legalName: '',
    formationState: '',
    registeredAddress: '',
    status: 'forming',
    posture: 'api_for_compounding',
    brand: 'clinic_supply',
    complianceMode: 'clinical-supply',
    customerTypes: Object.freeze(['503a_pharmacy', '503b_outsourcing_facility', 'licensed_clinic']),
    sending: {
      fromEnvVar: 'CLINIC_SUPPLY_FROM_EMAIL',
      replyToEnvVar: 'CLINIC_SUPPLY_REPLY_TO',
      postalAddressEnvVar: 'CLINIC_SUPPLY_POSTAL_ADDRESS',
      unsubscribeEnvVar: 'CLINIC_SUPPLY_UNSUBSCRIBE_EMAIL',
      smsFromEnvVar: 'CLINIC_SUPPLY_TWILIO_FROM_NUMBER',
      signature: Object.freeze({ name: '', brand: '', website: '' })
    }
  })
});

// Two entities sharing a from-address collapse the separation at the one point
// a recipient can observe it. Checked once, at load, so it cannot be introduced
// by a later edit without a startup failure.
(function assertDistinctSendingIdentities() {
  for (const key of ['fromEnvVar', 'smsFromEnvVar']) {
    const seen = new Map();
    for (const entity of Object.values(ENTITIES)) {
      const envVar = entity.sending[key];
      if (seen.has(envVar)) {
        throw new Error(
          `Entities "${seen.get(envVar)}" and "${entity.id}" both send from ${envVar}. `
          + 'Separate entities must have separate sending identities.'
        );
      }
      seen.set(envVar, entity.id);
    }
  }
})();

function getEntity(id) {
  const entity = ENTITIES[id];
  if (!entity) throw new Error(`Unknown entity: ${id}`);
  return entity;
}

function listEntities() {
  return Object.values(ENTITIES);
}

/**
 * Resolve an entity's sending identity, or explain why it has none.
 *
 * Returns `{ sendable, reasons, identity }` rather than throwing, so a dashboard
 * can show the owner exactly what is outstanding. `assertSendable` is the
 * throwing form for use on the actual send path.
 */
// Reasons an entity cannot send on ANY channel: it is not active, its facts
// are not recorded, or its compliance mode has no rules. Channel-specific
// address checks are layered on top, because an entity with no e-mail campaign
// is not thereby blocked from texting, and vice versa.
function entityLevelBlockers(entity) {
  const reasons = [];

  if (entity.status !== 'active') {
    reasons.push(`entity status is "${entity.status}" — only an active entity may send`);
  }
  const required = entity.posture === 'api_for_compounding'
    ? [...ACTIVATION_FIELDS, ...API_POSTURE_ACTIVATION_FIELDS]
    : ACTIVATION_FIELDS;
  for (const field of required) {
    if (!isFilled(entity[field])) reasons.push(`${field} is not recorded`);
  }

  if (!SUPPORTED_COMPLIANCE_MODES.includes(entity.complianceMode)) {
    reasons.push(
      `complianceMode "${entity.complianceMode}" is not implemented in lib/social/social-compliance.js, `
      + 'so every piece of this entity\'s copy would be blocked as unknown_compliance_mode'
    );
  }

  return reasons;
}

function describeSendability(entityId, env = process.env) {
  const entity = getEntity(entityId);
  const reasons = entityLevelBlockers(entity);

  const identity = {
    from: env[entity.sending.fromEnvVar] || '',
    replyTo: entity.sending.replyToEnvVar ? env[entity.sending.replyToEnvVar] || '' : '',
    postalAddress: env[entity.sending.postalAddressEnvVar] || '',
    unsubscribe: env[entity.sending.unsubscribeEnvVar] || ''
  };
  if (!isFilled(identity.from)) reasons.push(`${entity.sending.fromEnvVar} is not set`);

  return { entityId, sendable: reasons.length === 0, reasons, identity };
}

/**
 * The same question for SMS, which has its own origination identity.
 *
 * A2P 10DLC brand registration is tied to a legal entity's EIN, so an entity
 * texting from another entity's registered number is not a cosmetic problem —
 * it is sending under someone else's carrier registration.
 */
function describeSmsSendability(entityId, env = process.env) {
  const entity = getEntity(entityId);
  const reasons = entityLevelBlockers(entity);

  const identity = { smsFrom: env[entity.sending.smsFromEnvVar] || '' };
  if (!isFilled(identity.smsFrom)) reasons.push(`${entity.sending.smsFromEnvVar} is not set`);

  return { entityId, sendable: reasons.length === 0, reasons, identity };
}

function assertSmsSendable(entityId, env = process.env) {
  const outcome = describeSmsSendability(entityId, env);
  if (!outcome.sendable) {
    const error = new Error(`Entity "${entityId}" may not send SMS: ${outcome.reasons.join('; ')}`);
    error.code = 'ENTITY_NOT_SMS_SENDABLE';
    throw error;
  }
  return outcome.identity;
}

function assertSendable(entityId, env = process.env) {
  const outcome = describeSendability(entityId, env);
  if (!outcome.sendable) {
    const error = new Error(`Entity "${entityId}" may not send: ${outcome.reasons.join('; ')}`);
    error.code = 'ENTITY_NOT_SENDABLE';
    throw error;
  }
  return outcome.identity;
}

/**
 * A prospect belongs to the entity that acquired it.
 *
 * This is the guard that stops a med spa contacted under an RUO research-supply
 * pitch from later receiving a clinical-supply e-mail from a different company
 * because both campaigns happened to target med spas. The recipient did not
 * hear from two companies; they heard from one, twice, saying different things.
 */
function assertProspectEntity(prospect = {}, campaign = {}) {
  const prospectEntity = prospect.entityId ?? prospect.entity_id;
  if (!isFilled(prospectEntity)) {
    const error = new Error('Prospect has no entityId; it cannot be attributed to a sending entity.');
    error.code = 'PROSPECT_ENTITY_MISSING';
    throw error;
  }
  if (!isFilled(campaign.entityId)) {
    const error = new Error(`Campaign "${campaign.id}" has no entityId.`);
    error.code = 'CAMPAIGN_ENTITY_MISSING';
    throw error;
  }
  if (prospectEntity !== campaign.entityId) {
    const error = new Error(
      `Prospect was acquired by "${prospectEntity}" and cannot be mailed by campaign `
      + `"${campaign.id}" sending as "${campaign.entityId}". Re-acquire the contact under `
      + 'the second entity with its own consent, or leave it with the first.'
    );
    error.code = 'ENTITY_MISMATCH';
    throw error;
  }
  return true;
}

/**
 * Consent is given to a company, not to an operator running several.
 *
 * An opt-in recorded for one entity does not authorise another to write, and
 * under TCPA the same holds for SMS with no room for interpretation at all.
 */
function assertConsentScope(consent = {}, entityId) {
  if (consent.entityId !== entityId) {
    const error = new Error(
      `Consent was given to "${consent.entityId ?? '(none recorded)'}", not to "${entityId}". `
      + 'Consent does not transfer between entities.'
    );
    error.code = 'CONSENT_ENTITY_MISMATCH';
    throw error;
  }
  return true;
}

/** Suppression and consent keys are namespaced so the lists cannot merge by accident. */
function suppressionKey(entityId, identifier) {
  getEntity(entityId);
  return `suppression:${entityId}:${String(identifier || '').trim().toLowerCase()}`;
}

/** A release record's posture must be the posture of the entity holding it. */
function assertPostureMatch(entityId, posture) {
  const entity = getEntity(entityId);
  if (entity.posture !== posture) {
    const error = new Error(
      `Entity "${entityId}" holds the ${entity.posture} posture; a ${posture} record cannot sit under it.`
    );
    error.code = 'POSTURE_MISMATCH';
    throw error;
  }
  if (entity.status !== 'active') {
    const error = new Error(`Entity "${entityId}" is ${entity.status}; it cannot hold a release record yet.`);
    error.code = 'ENTITY_NOT_ACTIVE';
    throw error;
  }
  return true;
}

module.exports = {
  ACTIVATION_FIELDS,
  API_POSTURE_ACTIVATION_FIELDS,
  ENTITIES,
  POSTURES,
  STATUSES,
  assertConsentScope,
  assertEntityShape,
  assertPostureMatch,
  assertProspectEntity,
  assertSendable,
  assertSmsSendable,
  describeSendability,
  describeSmsSendability,
  getEntity,
  listEntities,
  suppressionKey
};

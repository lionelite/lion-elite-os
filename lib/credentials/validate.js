'use strict';

// Product credential validation.
//
// "Credentials" here means the documentary evidence that makes a product
// defensible: a certificate of analysis for a research peptide, a safety
// dossier for a cosmetic, a licensed clinician's attestation for a coaching
// protocol. Three product lines, three different regimes, so three validators.
//
// Every one FAILS CLOSED, matching the rest of this repo. A record is invalid
// until the real values are present. Nothing here invents a lab, a lot number,
// a purity figure, a license number, or a test result — those come from the
// issuing third party and are entered as data. A validator that passed on
// placeholder values would be worse than no validator, because it would let
// unverified product be presented as verified.
//
// This encodes commercial and regulatory practice. It is not legal advice and
// does not replace review by a qualified professional.

const { validateContent } = require('../social/social-compliance');

/** Release threshold for research peptide purity. Below this, do not ship. */
const MINIMUM_PURITY_PERCENT = 98;

function isFilled(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function isIsoDate(value) {
  if (!isFilled(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function collectMissing(record, fields, prefix = '') {
  return fields
    .filter(field => !isFilled(field.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), record)))
    .map(field => `${prefix}${field}`);
}

function result(missing, errors) {
  return { valid: missing.length === 0 && errors.length === 0, missing, errors };
}

/**
 * Certificate of analysis for a Research-Use-Only peptide.
 *
 * The independent-lab flag is deliberately separate from the lab's name: an
 * in-house result is still a result, but only a third party's supports a
 * "third-party tested" claim, and conflating them is how that claim becomes
 * false advertising.
 */
function validatePeptideCoa(record = {}) {
  const missing = collectMissing(record, [
    'productId', 'productName', 'lot', 'manufactureDate', 'retestDate',
    'purityPercent', 'purityMethod', 'identityMethod', 'appearance', 'storage',
    'lab.name', 'lab.reportId', 'lab.reportDate'
  ]);
  const errors = [];

  const purity = Number(record.purityPercent);
  if (isFilled(record.purityPercent)) {
    if (!Number.isFinite(purity) || purity <= 0 || purity > 100) {
      errors.push('purityPercent must be a number between 0 and 100');
    } else if (purity < MINIMUM_PURITY_PERCENT) {
      errors.push(`purity ${purity}% is below the ${MINIMUM_PURITY_PERCENT}% release threshold`);
    }
  }

  for (const field of ['manufactureDate', 'retestDate', 'lab.reportDate']) {
    const value = field.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), record);
    if (isFilled(value) && !isIsoDate(value)) errors.push(`${field} is not a valid date`);
  }

  if (isIsoDate(record.retestDate) && new Date(record.retestDate) <= new Date()) {
    errors.push('retestDate has passed; the lot needs re-testing before it is represented as current');
  }

  // Research-Use-Only is the entire legal posture of this product line.
  if (record.researchUseOnly !== true) {
    errors.push('researchUseOnly must be true for every Lion Elite Wellness product');
  }

  // Only a third-party result substantiates a third-party claim.
  if (record.lab?.independent !== true && record.claimsThirdPartyTested === true) {
    errors.push('cannot claim third-party testing without lab.independent === true');
  }

  return result(missing, errors);
}

/**
 * Safety and identity dossier for a cosmetic (Lion Elite Beauty skincare).
 *
 * Cosmetics are a different regime from research chemicals: the binding
 * constraints are ingredient disclosure, a safety assessment, and claim
 * substantiation. Under MoCRA a US-marketed cosmetic also needs facility
 * registration and product listing.
 */
function validateSkincareDossier(record = {}) {
  const missing = collectMissing(record, [
    'productId', 'productName', 'batchCode', 'periodAfterOpeningMonths',
    'safetyAssessment.assessorName', 'safetyAssessment.credential',
    'safetyAssessment.date', 'safetyAssessment.reportId',
    'manufacturing.facility', 'manufacturing.gmpStandard'
  ]);
  const errors = [];

  if (!Array.isArray(record.inci) || record.inci.length === 0) {
    missing.push('inci');
  }
  if (!Array.isArray(record.allergensDeclared)) {
    errors.push('allergensDeclared must be an array (use [] to assert none are present)');
  }

  if (record.manufacturing?.mocraFacilityRegistered !== true) {
    errors.push('MoCRA facility registration is required to market this in the US');
  }
  if (record.manufacturing?.mocraProductListed !== true) {
    errors.push('MoCRA product listing is required to market this in the US');
  }

  // Every marketing claim needs evidence behind it, and none may drift into
  // drug territory — a cosmetic that claims to treat a condition is a drug.
  const claims = Array.isArray(record.claims) ? record.claims : [];
  claims.forEach((claim, index) => {
    if (!isFilled(claim?.text)) {
      errors.push(`claims[${index}] has no text`);
      return;
    }
    if (!isFilled(claim?.substantiation)) {
      errors.push(`claims[${index}] ("${claim.text}") has no substantiation`);
    }
    const compliance = validateContent({ text: claim.text, complianceMode: 'coaching' });
    if (!compliance.approved) {
      const codes = compliance.blockers.map(blocker => blocker.code).join(', ');
      errors.push(`claims[${index}] ("${claim.text}") fails compliance: ${codes}`);
    }
  });

  return result(missing, errors);
}

/**
 * Clinician credentials behind a coaching peptide protocol.
 *
 * coaching_peptide_protocols already refuses to publish without
 * clinician_confirmed = true, enforced by a database CHECK. That boolean says
 * someone ticked a box; it does not say who, under what licence, or that
 * anyone checked. This is the record that has to exist behind the tick.
 *
 * A coach does not prescribe. The protocol is the clinician's, and this
 * validator refuses any record that says otherwise.
 */
function validateProtocolCredential(record = {}) {
  const missing = collectMissing(record, [
    'protocolId', 'clientId',
    'clinician.name', 'clinician.licenseType', 'clinician.licenseNumber',
    'clinician.licenseState', 'clinician.verifiedAt', 'clinician.verifiedBy',
    'informedConsent.obtainedAt'
  ]);
  // npi and informedConsent.documentId are deliberately optional: an NPI is
  // US-specific and a document id assumes a records system that may not exist.
  // Requiring either would make the gate unusable, and an unusable gate gets
  // worked around rather than satisfied.
  const errors = [];

  for (const field of ['clinician.verifiedAt', 'informedConsent.obtainedAt']) {
    const value = field.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), record);
    if (isFilled(value) && !isIsoDate(value)) errors.push(`${field} is not a valid date`);
  }

  if (isFilled(record.clinician?.licenseExpiresAt)) {
    if (!isIsoDate(record.clinician.licenseExpiresAt)) {
      errors.push('clinician.licenseExpiresAt is not a valid date');
    } else if (new Date(record.clinician.licenseExpiresAt) <= new Date()) {
      errors.push('clinician licence has expired');
    }
  }

  if (record.scope !== 'clinician_directed') {
    errors.push("scope must be 'clinician_directed' — a coach does not prescribe a protocol");
  }

  return result(missing, errors);
}

module.exports = {
  MINIMUM_PURITY_PERCENT,
  validatePeptideCoa,
  validateSkincareDossier,
  validateProtocolCredential
};

'use strict';

// Clinic / med-spa supply channel — release requirements.
//
// The Research-Use-Only certificate of analysis in `validate.js` is the
// credential for selling a research chemical to a research buyer. Supplying a
// clinic is a different transaction with a different evidence burden, and the
// difference is not a matter of degree: an RUO certificate carries a printed
// statement that the material is not for human, veterinary, diagnostic,
// therapeutic, or clinical use. Presenting that document as the credential
// behind a clinical sale contradicts the document.
//
// So this module refuses to let the two blur. Every record must declare a
// POSTURE, and each posture is validated against its own regime:
//
//   ruo_research_supply  The clinic buys as a research customer. The material
//                        stays RUO, stays disclaimed for human use, and the
//                        existing COA is the credential. No new testing is
//                        required — but no clinical representation may be made
//                        either, and that is the whole trade.
//
//   api_for_compounding  The material is sold as a bulk drug substance to a
//                        503A pharmacy or 503B outsourcing facility, which
//                        compounds and dispenses it. This is drug supply. It
//                        requires an FDA-registered cGMP manufacturer, a full
//                        release panel, and — the gate that no certificate can
//                        satisfy — bulk drug substance eligibility under the
//                        pathway being used.
//
// Both fail closed, like every other gate in this repo. Nothing here invents a
// test result, a registration number, or an eligibility determination.
//
// This encodes commercial and regulatory practice. It is NOT legal advice. The
// 503A/503B eligibility position in particular must be confirmed by regulatory
// counsel before any material moves.

const { validatePeptideCoa } = require('./validate');
const entityRegistry = require('../entities/registry');

/** Owner decision (2026-09-15): source material only from US-based suppliers. */
const REQUIRED_SOURCE_COUNTRY = 'US';

/** Compounding pathways this channel supports. */
const COMPOUNDING_PATHWAYS = Object.freeze(['503A', '503B']);

const POSTURES = Object.freeze(['ruo_research_supply', 'api_for_compounding']);

/**
 * The release panel, and which posture requires each line.
 *
 * `ruo` marks what a Research-Use-Only certificate already carries. `api`
 * marks what a bulk drug substance sold into compounding additionally needs.
 * The gap between the two columns is the honest answer to "is our current
 * testing enough?" — it is, for the first posture, and it is not, for the
 * second.
 */
const RELEASE_TESTS = Object.freeze([
  { id: 'identity', field: 'identityMethod', method: 'LC-MS', postures: ['ruo_research_supply', 'api_for_compounding'] },
  { id: 'purity', field: 'purityPercent', method: 'HPLC-UV', postures: ['ruo_research_supply', 'api_for_compounding'] },
  { id: 'appearance', field: 'appearance', method: 'visual', postures: ['ruo_research_supply', 'api_for_compounding'] },
  { id: 'endotoxin', field: 'endotoxin.result', method: 'LAL, USP <85>', postures: ['ruo_research_supply', 'api_for_compounding'] },
  { id: 'microbial', field: 'microbial.result', method: 'PCR or USP <61>/<62>', postures: ['ruo_research_supply', 'api_for_compounding'] },
  { id: 'elemental_impurities', field: 'elementalImpurities.result', method: 'ICP-MS, USP <232>/<233>', postures: ['ruo_research_supply', 'api_for_compounding'] },
  { id: 'net_content', field: 'netContentMg', method: 'gravimetric', postures: ['ruo_research_supply', 'api_for_compounding'] },

  // Everything below is absent from a typical RUO certificate and is what a
  // compounding pharmacy's incoming-material review actually asks for.
  { id: 'peptide_content', field: 'peptideContentPercent', method: 'assay (AAA or quantitative HPLC)', postures: ['api_for_compounding'] },
  { id: 'related_substances', field: 'impurities.totalPercent', method: 'HPLC related substances', postures: ['api_for_compounding'] },
  { id: 'water_content', field: 'waterContentPercent', method: 'Karl Fischer, USP <921>', postures: ['api_for_compounding'] },
  { id: 'residual_solvents', field: 'residualSolvents.result', method: 'GC, USP <467>', postures: ['api_for_compounding'] },
  { id: 'counterion', field: 'counterion.percent', method: 'ion chromatography', postures: ['api_for_compounding'] },
  { id: 'bioburden', field: 'bioburden.result', method: 'USP <61>', postures: ['api_for_compounding'] }
]);

function pluck(record, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), record);
}

function isFilled(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function isIsoDate(value) {
  if (!isFilled(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function isPass(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'pass';
}

/**
 * Which release tests a record carries, and which it is missing, for a posture.
 *
 * Reported separately from validation so the gap can be shown to the owner as a
 * list rather than discovered as a rejection.
 */
function summarizeTestCoverage(record = {}, posture = record.posture) {
  const applicable = RELEASE_TESTS.filter(spec => spec.postures.includes(posture));
  const covered = [];
  const missing = [];
  for (const spec of applicable) {
    (isFilled(pluck(record, spec.field)) ? covered : missing).push({
      id: spec.id, method: spec.method, field: spec.field
    });
  }
  return { posture, covered, missing };
}

/**
 * Bulk drug substance eligibility under 503A / 503B.
 *
 * A pharmacy may only compound from a bulk substance that has a USP/NF
 * monograph, is a component of an FDA-approved drug, or appears on the FDA
 * bulks list for that pathway. This is a property of the SUBSTANCE, not of the
 * lot — no certificate of analysis, at any purity, can supply it. An
 * investigational compound that is none of the three is ineligible however
 * clean the material is.
 *
 * The three bases are recorded as determinations made by counsel, not inferred
 * here, and all three defaulting to false is why this fails closed.
 */
function validateBulkSubstanceEligibility(basis = {}) {
  const errors = [];

  if (!COMPOUNDING_PATHWAYS.includes(basis.pathway)) {
    errors.push(`regulatoryBasis.pathway must be one of ${COMPOUNDING_PATHWAYS.join(', ')}`);
  }

  const eligible = basis.uspMonograph === true
    || basis.componentOfApprovedDrug === true
    || basis.onBulksList === true;

  if (!eligible) {
    errors.push(
      'bulk drug substance is not established as eligible for compounding: none of '
      + 'regulatoryBasis.uspMonograph, .componentOfApprovedDrug, or .onBulksList is true. '
      + 'No certificate of analysis can substitute for this — it is a property of the '
      + 'substance, not the lot.'
    );
  }

  if (!isFilled(basis.determinedBy) || !isIsoDate(basis.determinedOn)) {
    errors.push('regulatoryBasis.determinedBy and .determinedOn must record who made this determination and when');
  }

  return errors;
}

/**
 * Full release record for supplying a clinic or med spa.
 *
 * Composes the RUO certificate validation rather than restating it, so the
 * purity threshold, retest-date expiry, and date parsing stay defined once.
 *
 * `entities` is injectable so the api_for_compounding path can be exercised
 * before a real entity holding that posture exists. Production callers pass
 * nothing and get the real registry.
 */
function validateClinicSupplyRecord(record = {}, { entities = entityRegistry } = {}) {
  const missing = [];
  const errors = [];

  if (!POSTURES.includes(record.posture)) {
    return {
      valid: false,
      missing: ['posture'],
      errors: [`posture must be one of ${POSTURES.join(', ')} — the regime cannot be inferred`],
      coverage: { posture: record.posture ?? null, covered: [], missing: [] }
    };
  }

  // A release record belongs to the entity that will stand behind it, and its
  // posture must be that entity's posture. This is what stops an
  // api_for_compounding record being filed under the RUO entity to inherit its
  // active status, and stops any record at all being filed under an entity
  // that does not legally exist yet.
  if (!isFilled(record.entityId)) {
    missing.push('entityId');
  } else {
    try {
      entities.assertPostureMatch(record.entityId, record.posture);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const coa = validatePeptideCoa(record);
  missing.push(...coa.missing);
  // researchUseOnly is re-decided per posture below, so drop the base
  // validator's unconditional RUO error and re-derive it.
  errors.push(...coa.errors.filter(error => !error.startsWith('researchUseOnly must be true')));

  const coverage = summarizeTestCoverage(record, record.posture);
  for (const test of coverage.missing) {
    missing.push(`${test.field} (${test.id}: ${test.method})`);
  }

  for (const gate of ['endotoxin', 'microbial', 'elementalImpurities', 'bioburden', 'residualSolvents']) {
    const outcome = pluck(record, `${gate}.result`);
    if (isFilled(outcome) && !isPass(outcome)) {
      errors.push(`${gate}.result is "${outcome}" — a lot that did not pass is not releasable`);
    }
  }

  if (record.posture === 'ruo_research_supply') {
    if (record.researchUseOnly !== true) {
      errors.push('researchUseOnly must be true under the ruo_research_supply posture');
    }
    // The clinic is a research customer. If the record claims the material is
    // suitable for administration, the posture is wrong, not the wording.
    if (record.humanUseDisclaimed !== true) {
      errors.push(
        'humanUseDisclaimed must be true: an RUO certificate states the material is not for '
        + 'human, diagnostic, therapeutic, or clinical use, and the sale may not represent otherwise'
      );
    }
    if (record.clinicalUseRepresented === true) {
      errors.push(
        'clinicalUseRepresented is true under an RUO posture — that is the api_for_compounding '
        + 'regime, which requires bulk substance eligibility and an FDA-registered cGMP source'
      );
    }
    return { valid: missing.length === 0 && errors.length === 0, missing, errors, coverage };
  }

  // api_for_compounding
  if (record.researchUseOnly === true) {
    errors.push('researchUseOnly cannot be true for material sold as a bulk drug substance');
  }

  missing.push(...['source.manufacturerName', 'source.country', 'source.fdaEstablishmentRegistrationNumber', 'expiryDate']
    .filter(field => !isFilled(pluck(record, field))));

  const country = pluck(record, 'source.country');
  if (isFilled(country) && String(country).trim().toUpperCase() !== REQUIRED_SOURCE_COUNTRY) {
    errors.push(`source.country is "${country}" — supply is restricted to ${REQUIRED_SOURCE_COUNTRY}-based sources`);
  }
  if (pluck(record, 'source.cgmp') !== true) {
    errors.push('source.cgmp must be true: a bulk drug substance must come from a cGMP manufacturer');
  }

  if (isIsoDate(record.expiryDate) && new Date(record.expiryDate) <= new Date()) {
    errors.push('expiryDate has passed');
  }

  const peptideContent = Number(record.peptideContentPercent);
  if (isFilled(record.peptideContentPercent) && (!Number.isFinite(peptideContent) || peptideContent <= 0 || peptideContent > 100)) {
    errors.push('peptideContentPercent must be a number between 0 and 100');
  }

  // Purity by HPLC area-% and peptide content by assay are different numbers.
  // Conflating them is how a clinic ends up dosing against fill weight.
  if (Number.isFinite(peptideContent) && isFilled(record.netContentMg) && isFilled(record.purityPercent)
    && peptideContent > Number(record.purityPercent)) {
    errors.push('peptideContentPercent exceeds purityPercent — check that assay and chromatographic purity have not been conflated');
  }

  if (pluck(record, 'lab.independent') !== true) {
    errors.push('lab.independent must be true: a compounding pharmacy requires third-party release testing');
  }
  if (!isFilled(pluck(record, 'lab.accreditation'))) {
    missing.push('lab.accreditation (e.g. ISO/IEC 17025)');
  }

  errors.push(...validateBulkSubstanceEligibility(record.regulatoryBasis || {}));

  return { valid: missing.length === 0 && errors.length === 0, missing, errors, coverage };
}

module.exports = {
  COMPOUNDING_PATHWAYS,
  POSTURES,
  RELEASE_TESTS,
  REQUIRED_SOURCE_COUNTRY,
  summarizeTestCoverage,
  validateBulkSubstanceEligibility,
  validateClinicSupplyRecord
};

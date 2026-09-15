'use strict';

// Clinic / med-spa supply release requirements.
//
// The tests that matter here are the ones proving the two postures cannot be
// blurred: an RUO certificate must not carry a clinical representation, and a
// bulk drug substance must not release on certificate quality alone when the
// substance itself is not eligible for compounding.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  COMPOUNDING_PATHWAYS,
  RELEASE_TESTS,
  REQUIRED_SOURCE_COUNTRY,
  summarizeTestCoverage,
  validateClinicSupplyRecord
} = require('../lib/credentials/clinic-channel');

const TEMPLATE = path.join(__dirname, '..', 'credentials', 'templates', 'clinic-supply-record.json');
const readTemplate = () => JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));

const futureDate = (days = 365) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/**
 * A record carrying exactly the panel a strong Research-Use-Only certificate
 * carries today: identity, purity, appearance, endotoxin, microbial, elemental
 * impurities, net content — plus the dates and storage the certificate itself
 * usually omits.
 */
const ruoRecord = () => ({
  posture: 'ruo_research_supply',
  productId: 'lew-example-30mg',
  productName: 'Example Peptide 30mg',
  lot: 'LOT-EXAMPLE-0001',
  manufactureDate: '2026-08-20',
  retestDate: futureDate(),
  purityPercent: 99.99,
  purityMethod: 'HPLC-UV',
  identityMethod: 'LC-MS',
  appearance: 'White lyophilised powder',
  storage: 'Store at -20C, protect from light',
  netContentMg: 31.3,
  endotoxin: { method: 'LAL, USP <85>', result: 'Pass', sensitivityEuPerMl: 0.05, reportId: 'E-1' },
  microbial: { method: 'PCR', result: 'Pass', reportId: 'M-1' },
  elementalImpurities: { method: 'ICP-MS', result: 'Pass', analytes: ['As', 'Cd', 'Pb', 'Hg'] },
  lab: { name: 'Example Analytical Labs', independent: true, reportId: 'RPT-1', reportDate: '2026-08-25' },
  claimsThirdPartyTested: true,
  researchUseOnly: true,
  humanUseDisclaimed: true,
  clinicalUseRepresented: false
});

/** The same lot offered as a bulk drug substance into a compounding pathway. */
const apiRecord = () => ({
  ...ruoRecord(),
  posture: 'api_for_compounding',
  researchUseOnly: false,
  humanUseDisclaimed: false,
  expiryDate: futureDate(700),
  peptideContentPercent: 82.4,
  impurities: { method: 'HPLC related substances', largestSinglePercent: 0.4, totalPercent: 0.9 },
  waterContentPercent: 3.1,
  residualSolvents: { method: 'GC, USP <467>', result: 'Pass' },
  counterion: { identity: 'acetate', percent: 8.2 },
  bioburden: { method: 'USP <61>', result: 'Pass', cfuPerG: 0 },
  lab: {
    name: 'Example Analytical Labs', independent: true, accreditation: 'ISO/IEC 17025',
    accreditationNumber: 'L-0001', reportId: 'RPT-1', reportDate: '2026-08-25'
  },
  source: {
    manufacturerName: 'Example US Peptide Manufacturing',
    country: 'US',
    fdaEstablishmentRegistrationNumber: '3000000000',
    drugMasterFileNumber: 'DMF-00000',
    cgmp: true
  },
  regulatoryBasis: {
    pathway: '503B',
    uspMonograph: true,
    componentOfApprovedDrug: false,
    onBulksList: false,
    determinedBy: 'Regulatory counsel',
    determinedOn: '2026-09-10'
  }
});

test('the blank template fails closed under every posture', () => {
  for (const posture of ['ruo_research_supply', 'api_for_compounding']) {
    const outcome = validateClinicSupplyRecord({ ...readTemplate(), posture });
    assert.equal(outcome.valid, false, `blank template must not validate as ${posture}`);
  }
});

test('a record with no posture is refused rather than guessed at', () => {
  const { posture, ...rest } = ruoRecord();
  const outcome = validateClinicSupplyRecord(rest);
  assert.equal(outcome.valid, false);
  assert.deepEqual(outcome.missing, ['posture']);
});

test('the existing RUO panel is sufficient for research supply', () => {
  const outcome = validateClinicSupplyRecord(ruoRecord());
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.valid, true);
});

test('research supply may not carry a clinical representation', () => {
  const outcome = validateClinicSupplyRecord({ ...ruoRecord(), clinicalUseRepresented: true });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('api_for_compounding')));
});

test('research supply requires the human-use disclaimer the certificate itself carries', () => {
  const outcome = validateClinicSupplyRecord({ ...ruoRecord(), humanUseDisclaimed: false });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.startsWith('humanUseDisclaimed')));
});

test('a complete bulk drug substance record validates', () => {
  const outcome = validateClinicSupplyRecord(apiRecord());
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.valid, true);
});

test('the RUO panel alone is not enough to release as a bulk drug substance', () => {
  const outcome = validateClinicSupplyRecord({ ...ruoRecord(), posture: 'api_for_compounding', researchUseOnly: false });
  assert.equal(outcome.valid, false);
  for (const id of ['peptide_content', 'related_substances', 'water_content', 'residual_solvents', 'counterion', 'bioburden']) {
    assert.ok(outcome.missing.some(entry => entry.includes(id)), `expected ${id} to be reported missing`);
  }
});

test('an ineligible bulk substance is refused however clean the certificate is', () => {
  const record = apiRecord();
  record.purityPercent = 99.99;
  record.regulatoryBasis = { ...record.regulatoryBasis, uspMonograph: false, componentOfApprovedDrug: false, onBulksList: false };
  const outcome = validateClinicSupplyRecord(record);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('not established as eligible for compounding')));
});

test('an unrecognised compounding pathway is refused', () => {
  const record = apiRecord();
  record.regulatoryBasis = { ...record.regulatoryBasis, pathway: '503C' };
  const outcome = validateClinicSupplyRecord(record);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes(COMPOUNDING_PATHWAYS.join(', '))));
});

test('sourcing is restricted to US-based manufacturers', () => {
  const record = apiRecord();
  record.source = { ...record.source, country: 'CN' };
  const outcome = validateClinicSupplyRecord(record);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes(REQUIRED_SOURCE_COUNTRY)));
});

test('a non-cGMP source cannot supply a bulk drug substance', () => {
  const record = apiRecord();
  record.source = { ...record.source, cgmp: false };
  const outcome = validateClinicSupplyRecord(record);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('cgmp')));
});

test('a failed panel result blocks release', () => {
  const outcome = validateClinicSupplyRecord({
    ...ruoRecord(),
    endotoxin: { method: 'LAL, USP <85>', result: 'Fail', reportId: 'E-1' }
  });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('not releasable')));
});

test('peptide content above chromatographic purity is flagged as a conflation', () => {
  const outcome = validateClinicSupplyRecord({ ...apiRecord(), peptideContentPercent: 100 });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('conflated')));
});

test('coverage reports the gap between the two postures as a list', () => {
  const record = ruoRecord();
  assert.deepEqual(summarizeTestCoverage(record, 'ruo_research_supply').missing, []);

  const gap = summarizeTestCoverage(record, 'api_for_compounding').missing.map(entry => entry.id);
  assert.deepEqual(gap.sort(), ['bioburden', 'counterion', 'peptide_content', 'related_substances', 'residual_solvents', 'water_content']);
});

test('every release test declares at least one posture that requires it', () => {
  for (const spec of RELEASE_TESTS) {
    assert.ok(spec.postures.length > 0, `${spec.id} is required by no posture`);
    assert.ok(spec.method, `${spec.id} has no method`);
  }
});

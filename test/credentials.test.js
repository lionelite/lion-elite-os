'use strict';

// Product credential validation.
//
// The point of these validators is to make "verified" mean something. Each one
// fails closed, so the tests that matter most are the ones proving an
// incomplete or unsubstantiated record cannot pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MINIMUM_PURITY_PERCENT,
  validatePeptideCoa,
  validateSkincareDossier,
  validateProtocolCredential
} = require('../lib/credentials/validate');

const TEMPLATES = path.join(__dirname, '..', 'credentials', 'templates');
const readTemplate = name => JSON.parse(fs.readFileSync(path.join(TEMPLATES, name), 'utf8'));

function futureDate(days = 365) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

const validCoa = () => ({
  productId: 'lew-bpc157-5mg',
  productName: 'BPC-157 5mg',
  lot: 'LOT-EXAMPLE-0001',
  manufactureDate: '2026-01-15',
  retestDate: futureDate(),
  purityPercent: 99.1,
  purityMethod: 'HPLC',
  identityMethod: 'MS',
  appearance: 'White lyophilised powder',
  storage: 'Store at -20C, protect from light',
  lab: { name: 'Example Analytical Labs', independent: true, reportId: 'RPT-0001', reportDate: '2026-01-20' },
  claimsThirdPartyTested: true,
  researchUseOnly: true
});

test('every blank template fails closed', () => {
  for (const [file, validate] of [
    ['peptide-coa.json', validatePeptideCoa],
    ['skincare-dossier.json', validateSkincareDossier],
    ['protocol-credential.json', validateProtocolCredential]
  ]) {
    const outcome = validate(readTemplate(file));
    assert.equal(outcome.valid, false, `${file} must not validate while empty`);
  }
});

test('a complete certificate of analysis validates', () => {
  const outcome = validatePeptideCoa(validCoa());
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.valid, true);
});

test('purity below the release threshold is rejected', () => {
  const outcome = validatePeptideCoa({ ...validCoa(), purityPercent: MINIMUM_PURITY_PERCENT - 1 });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('release threshold')));
});

test('an expired retest date is rejected', () => {
  const outcome = validatePeptideCoa({ ...validCoa(), retestDate: '2020-01-01' });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('retestDate has passed')));
});

test('third-party testing cannot be claimed on an in-house result', () => {
  const coa = validCoa();
  coa.lab.independent = false;
  const outcome = validatePeptideCoa(coa);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('third-party')));
});

test('a research product that is not marked research-use-only is rejected', () => {
  const outcome = validatePeptideCoa({ ...validCoa(), researchUseOnly: false });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('researchUseOnly')));
});

const validDossier = () => ({
  productId: 'leb-serum-01',
  productName: 'Renewal Serum',
  inci: ['Aqua', 'Glycerin', 'Niacinamide'],
  allergensDeclared: [],
  batchCode: 'B-0001',
  periodAfterOpeningMonths: 12,
  expiryDate: futureDate(),
  safetyAssessment: { assessorName: 'Example Assessor', credential: 'Cosmetic safety assessor', date: '2026-02-01', reportId: 'CPSR-0001' },
  manufacturing: { facility: 'Example Facility', gmpStandard: 'ISO 22716', mocraFacilityRegistered: true, mocraProductListed: true },
  claims: [{ text: 'Leaves skin feeling hydrated', substantiation: 'Consumer panel, n=32, 4 weeks' }]
});

test('a complete cosmetic dossier validates', () => {
  const outcome = validateSkincareDossier(validDossier());
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.errors, []);
});

test('an unsubstantiated claim is rejected', () => {
  const dossier = validDossier();
  dossier.claims = [{ text: 'Leaves skin feeling hydrated', substantiation: '' }];
  const outcome = validateSkincareDossier(dossier);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('no substantiation')));
});

test('a cosmetic may not carry a drug claim', () => {
  const dossier = validDossier();
  dossier.claims = [{ text: 'Clinically proven to treat acne', substantiation: 'internal' }];
  const outcome = validateSkincareDossier(dossier);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('medical_claim')));
});

// Peptide actives are common in skincare, but the word crosses the brand line
// the compliance validator enforces. Better to discover that here than in a
// blocked campaign.
test('peptide wording on the Beauty line trips brand separation', () => {
  const dossier = validDossier();
  dossier.claims = [{ text: 'Contains copper peptides for firmer skin', substantiation: 'supplier data' }];
  const outcome = validateSkincareDossier(dossier);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('brand_separation')));
});

test('MoCRA registration and listing are both required', () => {
  const dossier = validDossier();
  dossier.manufacturing.mocraProductListed = false;
  const outcome = validateSkincareDossier(dossier);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('product listing')));
});

const validProtocol = () => ({
  protocolId: 'proto-0001',
  clientId: 'client-0001',
  clinician: {
    name: 'Example Clinician',
    licenseType: 'MD',
    licenseNumber: 'EXAMPLE-0000',
    licenseState: 'OH',
    npi: '0000000000',
    licenseExpiresAt: futureDate(),
    verifiedAt: '2026-03-01',
    verifiedBy: 'owner'
  },
  informedConsent: { obtainedAt: '2026-03-02', documentId: 'consent-0001' },
  scope: 'clinician_directed'
});

test('a complete protocol credential validates', () => {
  const outcome = validateProtocolCredential(validProtocol());
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.errors, []);
});

test('a protocol with no licence number is rejected', () => {
  const record = validProtocol();
  record.clinician.licenseNumber = '';
  const outcome = validateProtocolCredential(record);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.missing.includes('clinician.licenseNumber'));
});

test('an expired clinician licence is rejected', () => {
  const record = validProtocol();
  record.clinician.licenseExpiresAt = '2020-01-01';
  const outcome = validateProtocolCredential(record);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('expired')));
});

test('a protocol without informed consent is rejected', () => {
  const record = validProtocol();
  record.informedConsent.obtainedAt = '';
  const outcome = validateProtocolCredential(record);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.missing.includes('informedConsent.obtainedAt'));
});

test('a coach-directed protocol is rejected outright', () => {
  const outcome = validateProtocolCredential({ ...validProtocol(), scope: 'coach_directed' });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some(error => error.includes('a coach does not prescribe')));
});

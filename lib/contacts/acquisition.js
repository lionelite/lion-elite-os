'use strict';

// The acquisition spine: one door every contact comes through.
//
// Before this, each route had its own path to the store. OpenStreetMap went
// through discovery-run, a purchased file went through csv-import, Apollo went
// nowhere, and the affiliate webhook wrote straight to the prospects table.
// Four doors means four places to remember provenance, four places to classify
// a contact kind, and four places for the next one to be forgotten — which is
// how a personal Gmail ended up in a B2B prospect list.
//
// So every route calls acquire(). It refuses a source that is not in the
// manifest, refuses one that is explicitly excluded, attaches provenance, and
// returns accepted records alongside the refusals and the reasons. What it
// deliberately does NOT do is send, store, or enable anything: it decides
// admissibility and hands back a verdict. The caller persists.

const { CONTACT_SOURCES, isRefused, refusalFor } = require('./source-manifest');
const { evaluateSource, provenanceRecord, BUSINESS_CONTACT_KINDS } = require('./sources');
const { classifyContactKind, classifyPhone, ingestRecord } = require('./provider-ingest');

/**
 * Normalise one raw record from any route into the shape the gates read.
 *
 * Every route names its fields differently — OSM has `name`/`phone`/`website`,
 * Apollo has `companyName`/`phone_numbers`/`companyDomain`, a CSV has whatever
 * the seller called them. Normalising here rather than per-route means a new
 * source is a mapping, not another copy of the rules.
 */
function normaliseRecord(raw = {}, sourceId) {
  const website = raw.website || raw.companyDomain || raw.company_domain || raw.domain || '';
  return {
    sourceId,
    companyName: raw.companyName || raw.company_name || raw.name || '',
    contactName: raw.contactName || raw.contact_name || '',
    title: raw.title || '',
    companyDomain: website,
    email: raw.email || null,
    phoneNumbers: raw.phoneNumbers || raw.phone_numbers ||
      // A bare `phone` with no type is what OSM and most CSVs give. It is a
      // number a business publishes for customers, so it is typed as the
      // company line explicitly rather than left untyped — untyped fails
      // closed, and failing closed on a business's own published switchboard
      // would discard the one contact detail this pipeline reliably gets.
      (raw.phone ? [{ type: 'work_hq', sanitized_number: raw.phone }] : []),
    linkedinUrl: raw.linkedinUrl || raw.linkedin_url || null,
    address: raw.address || null,
    country: raw.country || raw.region || null,
    raw
  };
}

/**
 * Admit records from one source.
 *
 * `licence` is required for a licensed_provider source and meaningless for a
 * public one, which the manifest's sourceType decides rather than the caller.
 */
function acquire({ sourceId, records = [], licence = {}, env = process.env } = {}) {
  if (isRefused(sourceId)) {
    const refusal = refusalFor(sourceId);
    const error = new Error(`Source "${sourceId}" is not an available route. ${refusal.reason}`);
    error.code = 'SOURCE_REFUSED';
    error.alternative = refusal.alternative;
    throw error;
  }

  const source = CONTACT_SOURCES[sourceId];
  if (!source) {
    // An unregistered source is refused rather than waved through. A route
    // nobody declared is a route nobody reviewed.
    const error = new Error(
      `Unknown contact source "${sourceId}". Add it to lib/contacts/source-manifest.js ` +
      'with what it yields, what gates it, and its legal basis.'
    );
    error.code = 'SOURCE_UNREGISTERED';
    throw error;
  }

  const accepted = [];
  const refused = [];

  for (const raw of Array.isArray(records) ? records : []) {
    const record = normaliseRecord(raw, sourceId);

    // A licensed record has extra conditions attached to the contract it
    // arrived under, so it goes through the provider ingest, which enforces
    // them. Everything else is a public listing and needs only the kind and
    // provenance checks.
    if (source.sourceType === 'licensed_provider') {
      const result = ingestRecord(record, { licence: { providerId: sourceId, ...licence }, env });
      if (result.accepted) accepted.push({ ...result.prospect, sourceId });
      else refused.push({ companyName: record.companyName, blockers: result.blockers });
      continue;
    }

    const emailKind = classifyContactKind(record.email, record.companyDomain);
    const phoneKind = record.phoneNumbers.length ? classifyPhone(record.phoneNumbers[0]) : null;
    const contactKind = BUSINESS_CONTACT_KINDS.includes(emailKind) ? emailKind
      : phoneKind === 'company_phone' ? 'company_phone'
      : emailKind;

    const sourceShape = {
      type: source.sourceType,
      url: record.companyDomain || null,
      region: record.country || null,
      contactKind
    };
    const evaluation = evaluateSource(sourceShape, { env });
    const blockers = [...evaluation.blockers];

    if (!contactKind) blockers.push('No contact point on the record. Nothing to reach.');
    if (emailKind === 'personal_email') {
      blockers.push('Address is a personal mailbox. This pipeline is B2B only.');
    }

    if (blockers.length || !evaluation.approved) {
      refused.push({ companyName: record.companyName, blockers });
      continue;
    }

    accepted.push({
      sourceId,
      companyName: record.companyName,
      contactName: record.contactName,
      title: record.title,
      companyDomain: record.companyDomain || null,
      email: BUSINESS_CONTACT_KINDS.includes(emailKind) ? String(record.email).trim().toLowerCase() : null,
      companyPhone: phoneKind === 'company_phone'
        ? String(record.phoneNumbers[0].sanitized_number || record.phoneNumbers[0].sanitizedNumber).trim()
        : null,
      contactKind,
      address: record.address,

      // Same posture as the licensed route, for the same legal reason. A number
      // scraped from a shop window is no more consented than a purchased one.
      smsConsent: false,
      smsEligible: false,

      linkedinUrl: record.linkedinUrl,
      linkedinIsNotAChannel: true,

      provenance: provenanceRecord(sourceShape)
    });
  }

  return {
    sourceId,
    accepted,
    refused,
    stats: {
      received: Array.isArray(records) ? records.length : 0,
      accepted: accepted.length,
      refusedCount: refused.length,
      withEmail: accepted.filter(r => r.email).length,
      withPhone: accepted.filter(r => r.companyPhone).length,
      // Always zero, by authorization. Stated rather than omitted so a future
      // change to it is visible in a diff.
      smsEligible: 0
    }
  };
}

module.exports = { normaliseRecord, acquire };

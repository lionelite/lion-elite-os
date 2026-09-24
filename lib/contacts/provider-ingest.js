'use strict';

// Licensed B2B contact-data ingest.
//
// This is the link between a licensed provider (Apollo today) and the prospect
// pipeline. Without it a purchased record fails `approved_source` at the first
// of the sixteen checks, because it carries no provenance — so the provider
// adapter could search and reveal all day and nothing would ever become a
// sendable prospect.
//
// The owner authorized licensed third-party B2B contact data on 2026-09-22.
// Three conditions in that authorization are not preferences, and they are the
// reason this module exists rather than a loop that maps fields:
//
//   1. B2B only. `contactKind` outside work_email / company_general_email /
//      company_phone is refused, "so consumer personal data cannot enter on
//      this route". A provider will happily return a personal Gmail address
//      and a personal mobile; both are refused here, at import, because a
//      record that gets in is a record that gets sent to.
//   2. Licensed data feeds e-mail only. SMS needs prior express written
//      consent (TCPA) and "a purchased number is exactly what that prohibits".
//      So every phone from this route is marked smsEligible: false with the
//      reason attached, and consent is recorded as false rather than absent —
//      an absent field reads as "unknown" and unknown is what gets defaulted.
//   3. Provenance per record, because erasure and suppression are per person
//      and must survive the next import, and because a provider whose data
//      starts bouncing has to be quarantined without a deploy.
//
// Scraping is not an alternative route to the same data. LinkedIn's User
// Agreement prohibits automated collection, and a third party's terms are not
// ours to waive — which is why `linkedinUrl` is carried as an identifier only
// and is explicitly not a channel.

const { evaluateSource, provenanceRecord, BUSINESS_CONTACT_KINDS } = require('./sources');

// Free-mail domains. An address here belongs to a person, not a business, no
// matter whose org record the provider attached it to.
const FREE_MAIL_DOMAINS = Object.freeze([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com', 'fastmail.com'
]);

// A role address rather than a named person's mailbox. Still a business
// contact, but worth distinguishing: it is the right target for a company-level
// introduction and the wrong one for anything personalised.
const GENERIC_LOCAL_PARTS = Object.freeze([
  'info', 'contact', 'hello', 'sales', 'admin', 'office', 'support',
  'enquiries', 'inquiries', 'team', 'help', 'mail', 'general', 'reception'
]);

// Provider phone-type vocabulary. Apollo returns a `type` per number, and the
// distinction is the whole question: a switchboard is a company phone, a
// revealed mobile is a person's. Anything unrecognised is treated as personal,
// because defaulting an unknown type to "company" is how a mobile enters.
const COMPANY_PHONE_TYPES = Object.freeze(['work_hq', 'work_direct', 'work', 'office', 'main', 'hq']);
const PERSONAL_PHONE_TYPES = Object.freeze(['mobile', 'cell', 'home', 'personal', 'direct_dial']);

function normaliseDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0];
}

function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(at + 1).trim().toLowerCase();
}

function emailLocalPart(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : String(email).slice(0, at).trim().toLowerCase();
}

/**
 * Which kind of contact an address is, from the address and the company domain.
 *
 * Named for the contact *kind* it returns, not "classifyEmail": there is
 * already a classifyEmail in lib/email-enrichment.js answering a different
 * question ("is this address safe to use for the site we scraped it from"),
 * and two functions with one name are how the answers drift apart. This one
 * assigns a BUSINESS_CONTACT_KINDS value, which is what the authorization is
 * written in terms of.
 *
 * Returns null when there is no address at all, and 'personal_email' for one
 * that belongs to a person — a value deliberately outside
 * BUSINESS_CONTACT_KINDS so `evaluateSource` refuses it rather than this module
 * having to remember to.
 */
function classifyContactKind(email, companyDomain) {
  const address = String(email || '').trim().toLowerCase();
  if (!address || !address.includes('@')) return null;

  const domain = emailDomain(address);
  if (!domain) return null;
  if (FREE_MAIL_DOMAINS.includes(domain)) return 'personal_email';

  const company = normaliseDomain(companyDomain);
  const local = emailLocalPart(address);

  // A role mailbox is a company contact whether or not we know the domain.
  if (GENERIC_LOCAL_PARTS.includes(local)) return 'company_general_email';

  // Matching the company's own domain is what makes it a work address. A
  // subdomain counts (mail.acme.com), a lookalike does not (acme.co).
  if (company && (domain === company || domain.endsWith('.' + company))) return 'work_email';

  // A non-free-mail domain we cannot tie to the company. Not provably a work
  // address, so it is not claimed as one; recorded as unverified and refused,
  // because "probably corporate" is the reasoning that lets a personal domain
  // through.
  return 'unverified_email';
}

/**
 * Which kind of phone a provider record carries, from the provider's own type.
 */
function classifyPhone(phone) {
  if (!phone) return null;
  const number = String(phone.sanitizedNumber || phone.sanitized_number || phone.rawNumber || phone.raw_number || phone.number || '').trim();
  if (!number) return null;

  const type = String(phone.type || '').trim().toLowerCase();
  if (COMPANY_PHONE_TYPES.includes(type)) return 'company_phone';
  if (PERSONAL_PHONE_TYPES.includes(type)) return 'personal_phone';

  // Unknown or absent type. Fails closed: an unrecognised type is not promoted
  // to a company line.
  return 'untyped_phone';
}

function firstCompanyPhone(record) {
  const numbers = Array.isArray(record.phoneNumbers) ? record.phoneNumbers
    : Array.isArray(record.phone_numbers) ? record.phone_numbers
    : [];
  for (const phone of numbers) {
    if (classifyPhone(phone) === 'company_phone') {
      return {
        number: String(phone.sanitizedNumber || phone.sanitized_number || phone.rawNumber || phone.raw_number || phone.number).trim(),
        type: String(phone.type || '').toLowerCase()
      };
    }
  }
  return null;
}

/**
 * Turn one licensed-provider record into a prospect, or refuse it and say why.
 *
 * `licence` carries what the authorization requires per record: which provider,
 * under which licence reference, acquired when, for which region, and on what
 * lawful basis where one is needed. These are not derivable from the record —
 * they describe the contract the record arrived under — so they are required
 * arguments rather than optional metadata.
 */
function ingestRecord(record = {}, { licence = {}, env = process.env } = {}) {
  const blockers = [];
  const warnings = [];

  const companyDomain = normaliseDomain(record.companyDomain || record.company_domain);
  const emailKind = classifyContactKind(record.email, companyDomain);
  const phone = firstCompanyPhone(record);

  // Pick the contact point this record will be reached on. Email first: the
  // authorization limits this route to e-mail, so a phone-only record has no
  // usable channel even when the number is a legitimate company line.
  let contactKind = emailKind;
  if (!contactKind && phone) contactKind = 'company_phone';

  if (!contactKind) {
    blockers.push('No contact point on the record. Nothing to reach, so nothing to store.');
  }
  if (emailKind === 'personal_email') {
    blockers.push(
      'Address is a personal mailbox (free-mail domain). The licensed-data authorization is ' +
      'B2B only, so a personal address cannot enter on this route.'
    );
  }
  if (emailKind === 'unverified_email') {
    blockers.push(
      `Address domain does not match the company domain (${companyDomain || 'unknown'}), and is ` +
      'not a role mailbox. Not provably a work address, so it is not treated as one.'
    );
  }

  // The source shape the sixteen-check engine evaluates. Built here rather than
  // by the caller so a record cannot reach validation without provenance.
  const source = {
    type: 'licensed_provider',
    providerId: licence.providerId || record.sourceProvider || null,
    licenceRef: licence.licenceRef || null,
    acquiredAt: licence.acquiredAt || null,
    region: licence.region || record.country || null,
    lawfulBasis: licence.lawfulBasis || null,
    contactKind: BUSINESS_CONTACT_KINDS.includes(contactKind) ? contactKind : contactKind
  };

  const evaluation = evaluateSource(source, { env });
  blockers.push(...evaluation.blockers);
  warnings.push(...evaluation.warnings);

  const accepted = blockers.length === 0 && evaluation.approved;

  const prospect = accepted ? {
    contactName: record.contactName || '',
    title: record.title || '',
    companyName: record.companyName || '',
    companyDomain: companyDomain || null,
    email: emailKind && emailKind !== 'personal_email' && emailKind !== 'unverified_email'
      ? String(record.email).trim().toLowerCase()
      : null,
    contactKind,

    // Carried as an identifier for deduplication and for a human to open. It is
    // not a channel: automated LinkedIn connection requests and DMs are barred
    // by LinkedIn's User Agreement, which is a third party's terms and so not
    // the owner's to authorize. Naming that here stops the field being read as
    // a send target by whoever wires the next worker.
    linkedinUrl: record.linkedinUrl || null,
    linkedinIsNotAChannel: true,

    companyPhone: phone ? phone.number : null,

    // Recorded as an explicit false, not left absent. An absent consent field
    // reads as unknown, and unknown is what gets defaulted to true by a later
    // convenience. TCPA requires prior express written consent, a purchased
    // number is precisely what that prohibits, and no import can supply it.
    smsConsent: false,
    smsEligible: false,
    smsIneligibleReason: phone
      ? 'Licensed contact data feeds e-mail only. SMS requires prior express written consent (TCPA), which a purchased number cannot carry.'
      : null,

    provenance: provenanceRecord(source)
  } : null;

  return { accepted, prospect, blockers, warnings, contactKind, sourceEvaluation: evaluation };
}

/**
 * Ingest a batch, keeping what is usable and reporting what was refused.
 *
 * Refusals are returned rather than logged, for the same reason the lead
 * harvest reports per-source failures: an import that quietly drops 80% of a
 * purchased file looks identical to a small file, and the difference is money.
 */
function ingestBatch(records = [], { licence = {}, env = process.env } = {}) {
  const prospects = [];
  const refused = [];
  const refusedByReason = {};

  for (const record of Array.isArray(records) ? records : []) {
    const result = ingestRecord(record, { licence, env });
    if (result.accepted) {
      prospects.push(result.prospect);
      continue;
    }
    refused.push({
      companyName: record.companyName || '',
      contactName: record.contactName || '',
      blockers: result.blockers
    });
    for (const blocker of result.blockers) {
      const key = blocker.split('.')[0];
      refusedByReason[key] = (refusedByReason[key] || 0) + 1;
    }
  }

  return {
    prospects,
    refused,
    stats: {
      received: Array.isArray(records) ? records.length : 0,
      accepted: prospects.length,
      refusedCount: refused.length,
      refusedByReason,
      // Every accepted record on this route is e-mail only, by authorization.
      smsEligible: 0
    }
  };
}

module.exports = {
  FREE_MAIL_DOMAINS,
  GENERIC_LOCAL_PARTS,
  COMPANY_PHONE_TYPES,
  PERSONAL_PHONE_TYPES,
  classifyContactKind,
  classifyPhone,
  ingestRecord,
  ingestBatch
};

'use strict';

// Where a contact record came from, and whether that origin is approved.
//
// OWNER DECISION 2026-09-22: licensed third-party B2B contact data is authorized.
// The previous rule — "discovery enriches only a business's own published contact
// email (no data broker)" — is lifted for business contacts. See CLAUDE.md.
//
// That change has a concrete code consequence, which is why this module exists.
// `outreach-validation.js` computed `approved_source` as
// `Boolean(source.approved && source.url)` — it required a URL, because the only
// approved origin was a page we had scraped. A licensed provider record has no
// URL, so every purchased contact would have failed the first of the sixteen
// checks. Source approval is now a question of provenance rather than of having a
// link.
//
// WHY PROVENANCE IS PER-RECORD AND REQUIRED. With one origin ("we read their
// website") provenance was implicit. With several it has to be explicit, for three
// operational reasons that all cost real money when missing:
//
//   1. Erasure and suppression are per person. When someone asks to be removed we
//      need to know which source supplied them, so the same record does not
//      reappear on the next import.
//   2. Deliverability is per source. Bounce and complaint rates differ sharply
//      between providers, and a sender reputation is destroyed by one bad list.
//      `quarantineSource()` disables one origin without touching the others.
//   3. A provider licence is a contract. Most B2B data licences restrict
//      redistribution, so if a record is ever passed to an agency client we need
//      to know which licence governs it.
//
// Fail-closed, like every other gate here: a record whose origin is unrecognised,
// incomplete, or quarantined is not approved. A purchased list with no provenance
// is exactly the list nobody can defend later.

// Source types and what each must carry to count as approved.
const SOURCE_TYPES = Object.freeze({
  public_website: Object.freeze({
    label: 'The business\'s own published website',
    requires: Object.freeze(['url']),
    note: 'Scraped from a page the business publishes itself (lib/email-enrichment.js).',
  }),
  public_directory: Object.freeze({
    label: 'Approved public business directory',
    requires: Object.freeze(['url']),
    note: 'OpenStreetMap/Overpass and similar open business registries.',
  }),
  licensed_provider: Object.freeze({
    label: 'Licensed third-party B2B contact provider',
    // No URL: a provider record is a licensed row, not a page. What it must carry
    // instead is who supplied it, under what licence, and when.
    requires: Object.freeze(['providerId', 'licenceRef', 'acquiredAt']),
    note: 'Authorized by owner decision 2026-09-22. Business contacts only.',
  }),
  referral: Object.freeze({
    label: 'Direct referral or inbound introduction',
    requires: Object.freeze(['referredBy']),
    note: 'A person told us to contact them.',
  }),
  inbound: Object.freeze({
    label: 'Inbound — they contacted us',
    requires: Object.freeze([]),
    note: 'Form fill, reply, affiliate application. The strongest origin there is.',
  }),
});

// Regions where a cold B2B approach needs a recorded lawful basis rather than
// just a valid origin. Not a blanket block — a stated basis is enough — but an
// unknown region fails closed rather than being assumed to be the permissive one.
const LAWFUL_BASIS_REGIONS = Object.freeze(['EU', 'UK', 'EEA', 'CH']);
const ACCEPTED_LAWFUL_BASES = Object.freeze(['legitimate_interests', 'consent', 'contract']);

// Contact roles a licensed provider record may cover. Business contacts only:
// the authorization is for B2B, so a personal address is out of scope whatever
// the provider supplied.
const BUSINESS_CONTACT_KINDS = Object.freeze(['work_email', 'company_general_email', 'company_phone']);

/**
 * Which provider sources are currently quarantined, by id.
 *
 * Deliberately env-driven rather than a code constant: a provider whose data
 * starts bouncing needs disabling in minutes, without a deploy.
 */
function quarantinedProviders(env = process.env) {
  return String(env.CONTACT_SOURCE_QUARANTINE || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isQuarantined(source, env = process.env) {
  const id = String((source && source.providerId) || '').toLowerCase();
  return Boolean(id) && quarantinedProviders(env).includes(id);
}

/**
 * Evaluate a record's origin.
 *
 * Returns `{ approved, type, blockers, warnings }`. Every failure is named, so a
 * blocked import says which field is missing rather than "source not approved".
 */
function evaluateSource(source = {}, { env = process.env } = {}) {
  const blockers = [];
  const warnings = [];
  let type = source && source.type;

  // Backward compatibility, and it is load-bearing rather than cosmetic: every
  // prospect stored before this module existed carries `{ approved: true, url }`
  // with no `type`. Requiring a type outright would fail `approved_source` for the
  // entire existing prospect table and halt the live pipeline. A legacy record
  // with an explicit approval and a URL is what `public_website` now means, so it
  // is read as that — and flagged, so the inference is visible rather than silent.
  if (!type && source && source.approved === true && source.url) {
    type = 'public_website';
    warnings.push('Legacy source shape ({ approved, url }) read as public_website. Set an explicit `type` on new records.');
  }

  if (!type) {
    return { approved: false, type: null, blockers: ['Source has no type. An unlabelled origin cannot be approved.'], warnings };
  }
  const definition = SOURCE_TYPES[type];
  if (!definition) {
    return {
      approved: false,
      type,
      blockers: [`Unknown source type "${type}". Approved types: ${Object.keys(SOURCE_TYPES).join(', ')}.`],
      warnings,
    };
  }

  for (const field of definition.requires) {
    if (!source[field]) blockers.push(`Source of type "${type}" requires "${field}".`);
  }

  if (type === 'licensed_provider') {
    if (isQuarantined(source, env)) {
      blockers.push(`Provider "${source.providerId}" is quarantined (CONTACT_SOURCE_QUARANTINE). Its records are not usable until it is removed from that list.`);
    }
    // B2B only — the authorization does not extend to consumer personal data.
    if (source.contactKind && !BUSINESS_CONTACT_KINDS.includes(source.contactKind)) {
      blockers.push(`Contact kind "${source.contactKind}" is not a business contact. The licensed-data authorization covers B2B only (${BUSINESS_CONTACT_KINDS.join(', ')}).`);
    }
    if (!source.contactKind) {
      warnings.push('No contactKind recorded. Record it at import so a personal address cannot enter a B2B campaign unnoticed.');
    }
    // Region and lawful basis.
    const region = String(source.region || '').toUpperCase();
    if (!region) {
      blockers.push('Licensed records must record a region, so the right rules can be applied. Unknown region fails closed rather than defaulting to the most permissive one.');
    } else if (LAWFUL_BASIS_REGIONS.includes(region)) {
      if (!source.lawfulBasis) {
        blockers.push(`Region ${region} requires a recorded lawfulBasis (${ACCEPTED_LAWFUL_BASES.join(' / ')}) for a cold B2B approach.`);
      } else if (!ACCEPTED_LAWFUL_BASES.includes(source.lawfulBasis)) {
        blockers.push(`lawfulBasis "${source.lawfulBasis}" is not one of ${ACCEPTED_LAWFUL_BASES.join(', ')}.`);
      }
    }
    // Provider warranties are worth recording but are not a substitute for our
    // own checks — suppression and CAN-SPAM obligations are ours regardless.
    if (source.providerWarrantsLawfulSourcing !== true) {
      warnings.push('Provider has not been recorded as warranting lawful sourcing. Worth capturing from the licence, but it does not transfer our own suppression and unsubscribe obligations.');
    }
  }

  return { approved: blockers.length === 0, type, definition, blockers, warnings };
}

/**
 * Is this origin approved? The boolean the validation engine's `approved_source`
 * check consumes.
 */
function isApprovedSource(source, options) {
  return evaluateSource(source, options).approved;
}

/**
 * Normalise provenance for storage alongside a prospect, so an erasure or
 * suppression request can be traced back to the import that produced it.
 */
function provenanceRecord(source = {}) {
  return {
    type: source.type || null,
    url: source.url || null,
    providerId: source.providerId || null,
    licenceRef: source.licenceRef || null,
    acquiredAt: source.acquiredAt || null,
    region: source.region ? String(source.region).toUpperCase() : null,
    lawfulBasis: source.lawfulBasis || null,
    contactKind: source.contactKind || null,
    referredBy: source.referredBy || null,
    recordedAt: new Date().toISOString(),
  };
}

module.exports = {
  SOURCE_TYPES,
  LAWFUL_BASIS_REGIONS,
  ACCEPTED_LAWFUL_BASES,
  BUSINESS_CONTACT_KINDS,
  quarantinedProviders,
  isQuarantined,
  evaluateSource,
  isApprovedSource,
  provenanceRecord,
};

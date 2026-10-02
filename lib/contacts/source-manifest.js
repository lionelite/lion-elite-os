'use strict';

// Every route by which a contact can enter the pipeline.
//
// Declarative, and dependency-free so tests and the CLI can read it without a
// database, a queue or a network call. The same reason lib/queue-manifest.js is
// declared rather than inferred: a registry that is derived by scanning code
// silently under-reports, and a guard that under-reports is worse than none.
//
// This exists because the acquisition story was spread across six modules with
// no single place that said what we actually have. Each route below states what
// it yields, what it costs, what has to be true before it runs, and whether it
// works today — so "how do we get the info" has one answer instead of an
// archaeology session.
//
// `status` is the honest field and the point of the file:
//   live     — running and producing today
//   blocked  — built, but something outside the code stops it
//   ready    — built and correct, waiting on a credential or a human decision
//   inert    — built and wired to nothing; produces nothing until someone acts

const CONTACT_SOURCES = Object.freeze({
  openstreetmap: Object.freeze({
    id: 'openstreetmap',
    sourceType: 'public_directory',
    status: 'live',
    yields: Object.freeze(['companyName', 'company_phone', 'website', 'address', 'category']),
    // Verified 2026-09-24 on a GitHub runner: 32 businesses in Cleveland in 13
    // seconds, 25 new in Miami. 106 leads on record, 69 with a phone.
    costPerRecord: 0,
    gate: null,
    legalBasis: 'Businesses own public listings, under the ODbL. No personal data, no broker.',
    reachableFrom: 'github-runner',
    notes: 'The dev sandbox proxy 403s Overpass, so this can only be exercised on a runner.'
  }),

  own_website_enrichment: Object.freeze({
    id: 'own_website_enrichment',
    sourceType: 'public_website',
    status: 'live',
    yields: Object.freeze(['work_email', 'company_general_email']),
    costPerRecord: 0,
    gate: null,
    legalBasis: 'The contact address a business publishes on its own site.',
    reachableFrom: 'github-runner',
    notes: 'Feeds off openstreetmap. classifyEmail returns an eligibility verdict; honour it.'
  }),

  licensed_provider: Object.freeze({
    id: 'licensed_provider',
    sourceType: 'licensed_provider',
    status: 'ready',
    yields: Object.freeze(['contactName', 'title', 'work_email', 'company_phone', 'linkedinUrl']),
    // Apollo's published list price at the time of writing. Recorded as an
    // order of magnitude for planning, not as a quote.
    costPerRecord: 0.03,
    gate: 'APOLLO_API_KEY',
    legalBasis: 'Owner amendment 2026-09-22. B2B only, e-mail only, provenance per record.',
    reachableFrom: 'anywhere',
    notes: 'lib/platform/sources/apollo.js searches; lib/contacts/provider-ingest.js admits.'
  }),

  csv_import: Object.freeze({
    id: 'csv_import',
    sourceType: 'licensed_provider',
    status: 'ready',
    yields: Object.freeze(['contactName', 'work_email', 'company_phone']),
    costPerRecord: 0,
    gate: null,
    legalBasis: 'Whatever licence the file arrived under — which is why licenceRef is required.',
    reachableFrom: 'anywhere',
    notes: 'A purchased file still needs its licence recorded per record. No licence, no import.'
  }),

  affiliate_webhook: Object.freeze({
    id: 'affiliate_webhook',
    sourceType: 'inbound',
    status: 'ready',
    yields: Object.freeze(['contactName', 'work_email', 'company_phone']),
    costPerRecord: 0,
    gate: 'AFFILIATE_WEBHOOK_SECRET',
    legalBasis: 'The applicant submitted their own details.',
    reachableFrom: 'anywhere',
    notes: 'Backend exists; no applicant-facing form is built yet.'
  }),

  bluesky_search: Object.freeze({
    id: 'bluesky_search',
    sourceType: 'public_website',
    status: 'blocked',
    yields: Object.freeze(['handle', 'postUrl', 'statedIntent']),
    costPerRecord: 0,
    gate: 'BLUESKY_HANDLE + BLUESKY_APP_PASSWORD as GitHub secrets',
    legalBasis: 'Public posts. Read-only; engagement stays a manual human action.',
    reachableFrom: 'nowhere-unauthenticated',
    // 23 of 23 searches have returned HTTP 403 on every run for weeks:
    // public.api.bsky.app refuses datacenter IPs and Actions runners are Azure.
    // Authenticated search is the fix and needs the credentials as secrets.
    notes: 'Yields no email or phone — a handle is a channel, not a contact detail.'
  })
});

// Routes that are explicitly not available, with the reason. Recorded rather
// than omitted: an absent option gets proposed again every few weeks, and the
// answer to "why not just scrape LinkedIn" should live in code next to the
// registry it is excluded from.
const REFUSED_SOURCES = Object.freeze({
  linkedin_scrape: Object.freeze({
    id: 'linkedin_scrape',
    reason:
      'Automated collection of LinkedIn profiles is prohibited by the LinkedIn User Agreement. ' +
      'A third party’s terms are not the owner’s to waive, so this is not an authorization ' +
      'question. Licensed provider data is the supported route to the same fields.',
    alternative: 'licensed_provider'
  }),
  people_search_broker: Object.freeze({
    id: 'people_search_broker',
    reason:
      'Consumer people-search data is outside the B2B-only authorization: a contactKind other ' +
      'than work_email, company_general_email or company_phone is refused at import.',
    alternative: 'licensed_provider'
  }),
  purchased_mobile_for_sms: Object.freeze({
    id: 'purchased_mobile_for_sms',
    reason:
      'TCPA requires prior express written consent before texting. A purchased number is exactly ' +
      'what that prohibits, and no licence can supply the consent, so licensed data feeds e-mail only.',
    alternative: 'consented opt-in capture'
  })
});

/** Sources producing records today. */
function liveSources() {
  return Object.values(CONTACT_SOURCES).filter(source => source.status === 'live');
}

/**
 * Sources that are built but produce nothing, with what each is waiting on.
 *
 * This is the number worth watching. The repo's recurring failure is code that
 * is complete, tested, and wired to nothing — so a count of "ready" and
 * "blocked" is a truer picture of the pipeline than a count of modules.
 */
function dormantSources() {
  return Object.values(CONTACT_SOURCES)
    .filter(source => source.status !== 'live')
    .map(source => ({ id: source.id, status: source.status, waitingOn: source.gate || source.notes }));
}

/** Which sources can actually produce an e-mail address or a phone number. */
function sourcesYielding(field) {
  return Object.values(CONTACT_SOURCES).filter(source => source.yields.includes(field));
}

function isRefused(id) {
  return Object.prototype.hasOwnProperty.call(REFUSED_SOURCES, id);
}

function refusalFor(id) {
  return REFUSED_SOURCES[id] || null;
}

module.exports = {
  CONTACT_SOURCES,
  REFUSED_SOURCES,
  liveSources,
  dormantSources,
  sourcesYielding,
  isRefused,
  refusalFor
};

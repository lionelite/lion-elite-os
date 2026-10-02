# Contact acquisition — the bones of the operation

How a contactable business gets into the pipeline, by which route, at what
cost, and what has to be true before each route runs.

Run `npm run contacts:sources` for the live version of this — it reads
`lib/contacts/source-manifest.js`, so it cannot drift from the code the way a
document can.

## The shape

```
  source  ──►  normaliseRecord()  ──►  contact-kind classification
                                         │
                                         ▼
                                    evaluateSource()   ← the 16-check engine's
                                         │               approved_source gate
                                         ▼
                                    provenanceRecord()
                                         │
                                         ▼
                              accepted[] + refused[] (with reasons)
                                         │
                                         ▼
                                   caller persists
```

One door: `lib/contacts/acquisition.js` `acquire({ sourceId, records, licence })`.

It was four doors. OpenStreetMap went through `discovery-run`, a purchased file
through `csv-import`, Apollo went nowhere, and the affiliate webhook wrote
straight to the `prospects` table. Four doors meant four places to remember
provenance and four places to classify a contact — which is how a personal
Gmail ended up in a B2B prospect list on 2026-09-24.

`acquire()` decides admissibility and returns a verdict. It does not store,
send, or enable anything.

## The routes

| Route | Status | Cost/record | Yields |
|---|---|---|---|
| `openstreetmap` | **live** | free | company name, phone, website, address |
| `own_website_enrichment` | **live** | free | work email, role mailbox |
| `licensed_provider` (Apollo) | ready | ~$0.03 | contact name, title, work email, company phone, LinkedIn URL |
| `csv_import` | ready | free | contact name, work email, company phone |
| `affiliate_webhook` | ready | free | contact name, work email, company phone |
| `bluesky_search` | blocked | free | handle, post URL — **no email or phone** |

### openstreetmap — the one that works today

Businesses' own public listings, via Overpass. Verified on a GitHub runner on
2026-09-24: 32 businesses in Cleveland in 13 seconds, 25 new in Miami. The
store now holds 106 leads, 69 with a phone and 101 with a website.

Queries are per-category and spaced, because a single union of every category
over a wide box is what Overpass sheds first — that is what had the harvest
returning zero for weeks. Search areas rotate by the UTC hour across eleven
metros; eight are Florida, where the campaigns actually sell.

The dev sandbox proxy 403s Overpass, so this can only be exercised on a runner:
`Lead Harvest` with `business: true`, and `rotation: N` to pin one market.

### own_website_enrichment — where the email comes from

Reads the contact address a business publishes on its own site, off the back of
an OpenStreetMap listing. `lib/email-enrichment.js` `classifyEmail()` returns an
eligibility verdict; **honour it**. The Gmail incident happened because the
caller took `found.email` and never read `eligible`. A signal that is computed
and ignored is worse than no signal — it makes the pipeline look guarded.

### licensed_provider — the route to scale

`lib/platform/sources/apollo.js` searches B2B people by ICP (titles,
seniorities, geography, domains, keywords) and matches against
`/api/v1/people/match`. `lib/contacts/provider-ingest.js` admits the results.

Authorized by the owner on 2026-09-22, with three conditions enforced in code:

1. **B2B only.** Free-mail domains refused. An address whose domain cannot be
   tied to the company is refused rather than assumed corporate. Role mailboxes
   accepted. Phone kind comes from the provider's own type — a switchboard is a
   company phone, a revealed mobile is a person's, an unknown type fails closed.
2. **E-mail only.** Every phone is `smsEligible: false` with the reason, and
   `smsConsent` is written as an explicit `false`. TCPA requires prior express
   written consent; a purchased number is precisely what that prohibits.
3. **Provenance per record.** `providerId`, `licenceRef`, `acquiredAt`, `region`,
   and a `lawfulBasis` for EU/UK/EEA/CH. A missing licence reference is refused,
   not defaulted. Erasure and suppression are per person and must survive the
   next import.

To turn on: set `APOLLO_API_KEY`, then pass `licence: { licenceRef, acquiredAt,
region }` to `acquire()`. Both are human actions — the key is a paid credential.

### bluesky_search — blocked, and not the gap you think

23 of 23 searches return HTTP 403 on every run: `public.api.bsky.app` refuses
datacenter IPs and Actions runners are Azure. Authenticated search fixes it, and
needs `BLUESKY_HANDLE` / `BLUESKY_APP_PASSWORD` as **GitHub secrets** — they
exist only in the Render dashboard today.

Worth knowing before spending time on it: this route yields a **handle**, not an
email or a phone. It finds people stating intent. It does not produce the contact
data an outbound engine needs.

## Not available, and why

These are recorded in `REFUSED_SOURCES` rather than simply absent, because an
absent option gets proposed again every few weeks.

- **LinkedIn scraping** — automated collection of profiles is prohibited by the
  LinkedIn User Agreement. A third party's terms are not the owner's to waive,
  so this is not an authorization question. Licensed provider data is the
  supported route to the same fields. The `linkedinUrl` **is** carried on a
  record, as an identifier for deduplication and for a human to open, alongside
  an explicit `linkedinIsNotAChannel` flag. A CSV row whose only contact was a
  LinkedIn URL used to import as "reachable"; it no longer does.
- **People-search / consumer brokers** — outside the B2B-only authorization. A
  `contactKind` other than `work_email`, `company_general_email` or
  `company_phone` is refused at import.
- **Purchased mobiles for SMS** — TCPA. No licence can supply consent.

## Adding a route

1. Declare it in `lib/contacts/source-manifest.js` with what it yields, its
   cost, its gate, and its legal basis. An undeclared source throws
   `SOURCE_UNREGISTERED` — a route nobody declared is a route nobody reviewed.
2. Map its field names in `normaliseRecord()`. A new source should be a mapping,
   not another copy of the rules.
3. Nothing else. The gates apply because there is only one door.

## What this does not do

No route here sends anything. Enabling a send path is a separate human action
(`OUTREACH_SEND_ENABLED` + Resend credentials, per
`docs/automated-outreach.md`), and the switch belongs to the owner.

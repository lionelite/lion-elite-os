# Outreach Validation and Email Enrichment API

Lion Elite OS includes a standalone fail-closed service for prospect qualification, public business email enrichment, and outreach authorization.

## Start

```bash
npm install
npm run outreach
```

Default port: `3001`. Override with `OUTREACH_PORT`.

## Validation Endpoints

### `POST /api/outreach/fingerprint`

Creates a deterministic business fingerprint from normalized domain, phone, company name, and region.

### `POST /api/outreach/score`

Calculates an explainable weighted qualification score.

```json
{
  "signals": {
    "overallFit": 0.9,
    "buyingPotential": 0.8,
    "timingIndicators": 0.6,
    "strategicValue": 0.9,
    "dataConfidence": 1,
    "personalizationReadiness": 0.9
  }
}
```

All signal values are clamped between `0` and `1`.

### `POST /api/outreach/validate`

Evaluates every required checkpoint. A failed validation returns HTTP `422`.

### `POST /api/outreach/authorize`

Performs the final pre-send validation. Authorization succeeds only when every required checkpoint passes. Successful responses contain a deterministic idempotency key that must be stored with the outbound event and protected by a unique database constraint.

## Email Enrichment Endpoints

### `POST /api/enrichment/email`

Checks an official business website and a limited set of same-domain contact, about, team, staff, and partnership pages for a publicly displayed business email.

```json
{
  "business": {
    "name": "Example Fitness",
    "website": "https://example.com"
  },
  "policy": {
    "minimumEmailConfidence": 80
  },
  "maxPages": 6
}
```

A verified result includes:

- Normalized business email
- Confidence score
- Exact source URL
- Evidence type (`mailto` or visible page text)
- Capture timestamp
- Domain-match status
- Role-inbox status

The agent does not:

- Guess email formats
- Generate addresses from employee names
- Search people-finder or household-data sites
- Accept third-party mailbox domains as verified business addresses
- Treat a contact form as an email address
- Release a prospect without evidence

### `POST /api/enrichment/email/batch`

Processes up to 25 official business websites sequentially and reports verified and blocked records.

```json
{
  "businesses": [
    { "name": "Business One", "website": "https://one.example" },
    { "name": "Business Two", "website": "https://two.example" }
  ]
}
```

Blocked reasons include:

- `MISSING_OFFICIAL_WEBSITE`
- `OFFICIAL_WEBSITE_UNAVAILABLE`
- `NO_VERIFIED_PUBLIC_BUSINESS_EMAIL`
- `ENRICHMENT_ERROR`

## Required Outreach Checks

1. Approved source
2. Verified identity
3. Duplicate prevention
4. Campaign eligibility
5. Suppression and opt-out clearance
6. Required business information
7. Data freshness
8. Qualification threshold
9. Personalization quality
10. Evidence coverage
11. CRM synchronization
12. Cadence eligibility
13. Channel eligibility
14. Campaign compliance
15. Frequency limit
16. Approved message version

Missing and unknown values fail closed.

## Release Sequence

```text
Official website
→ Public email enrichment
→ Evidence and confidence threshold
→ CRM synchronization
→ Qualification
→ Personalization
→ Final validation
→ Outreach authorization
→ Delivery worker
```

## Important Deployment Rule

This service enriches and authorizes outreach; it does not itself send email, SMS, or social messages. The delivery worker must require a valid authorization result, store the validation run ID, verify suppression again immediately before delivery, and enforce uniqueness on the returned idempotency key before calling any communication provider.

## Run Tests

```bash
npm test
```

Tests cover normalization, email extraction, same-domain enforcement, public-source evidence, blocked enrichment, deduplication fingerprints, explainable scoring, stale records, opt-outs, missing CRM synchronization, fail-closed behavior, and idempotency.

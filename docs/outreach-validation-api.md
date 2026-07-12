# Outreach Validation API

Lion Elite OS now includes a standalone fail-closed validation service for prospect qualification and outreach authorization.

## Start

```bash
npm install
npm run outreach
```

Default port: `3001`. Override with `OUTREACH_PORT`.

## Endpoints

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

Performs the final pre-send validation. Authorization succeeds only when every required checkpoint passes. Successful responses contain a deterministic idempotency key that should be stored with the outbound event and protected by a unique database constraint.

## Required Checks

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

## Important Deployment Rule

This service authorizes an outreach action; it does not itself send email, SMS, or social messages. The eventual delivery worker must require a valid authorization result, store the validation run ID, and enforce uniqueness on the returned idempotency key before calling any communication provider.

## Run Tests

```bash
npm test
```

Tests cover normalization, deduplication fingerprints, explainable scoring, stale records, opt-outs, missing CRM synchronization, fail-closed behavior, and idempotency.

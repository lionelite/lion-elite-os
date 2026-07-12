# Outreach Validation API

Lion Elite OS includes a fail-closed validation, enrichment, personalization, prospect pipeline, and outreach authorization service.

## Start

```bash
npm install
npm run outreach
```

Default port: `3001`. Override with `OUTREACH_PORT`.

## Email Generation Agent

### `POST /api/outreach/email/generate`

Generates a personalized Lion Elite Beauty partnership email using structured business context.

Recommended request:

```json
{
  "context": {
    "businessName": "Example Fitness",
    "contactName": "Jordan",
    "category": "Personal training studio",
    "location": "Miami, FL",
    "partnershipAngle": "referral and affiliate partnership",
    "goal": "helping members stay consistent beyond their initial program",
    "specificOpportunity": "give members a structured accountability option between sessions",
    "verifiedFacts": [
      {
        "status": "verified",
        "text": "Example Fitness offers one-on-one personal training"
      }
    ]
  }
}
```

The generator returns:

- Subject line
- Personalized email body
- Selected partnership offer
- Personalization inputs used
- Quality score and dimension breakdown
- Approval status
- Required Alexander Ringfield signature with `216-326-0050`

The agent separates verified facts from inferred goals, does not invent private problems, and blocks prohibited guarantees or treatment claims.

### `POST /api/outreach/email/score`

Scores an existing draft for:

- Specificity
- Relevance
- Value clarity
- Rapport
- Call-to-action quality
- Readability
- Signature completeness
- Evidence usage

A draft below the configured personalization threshold or containing a blocker is not approved.

## Other Endpoints

### `POST /api/outreach/fingerprint`

Creates a deterministic business fingerprint from normalized domain, phone, company name, and region.

### `POST /api/outreach/score`

Calculates an explainable weighted qualification score.

### `POST /api/outreach/validate`

Evaluates every required checkpoint. A failed validation returns HTTP `422`.

### `POST /api/outreach/authorize`

Performs the final pre-send validation. Authorization succeeds only when every required checkpoint passes. Successful responses contain a deterministic idempotency key that must be stored with the outbound event and protected by a unique database constraint.

### `POST /api/enrichment/email`

Looks for publicly displayed business email addresses on the official business website and same-domain pages.

### `POST /api/enrichment/email/batch`

Runs email enrichment for up to 25 businesses.

### Prospect Pipeline

```text
POST  /api/prospects
GET   /api/prospects
GET   /api/prospects/:id
PATCH /api/prospects/:id
POST  /api/prospects/:id/transition
POST  /api/prospects/:id/queue
GET   /api/outreach/queue
PATCH /api/outreach/queue/:id
GET   /api/metrics/pipeline
```

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

This service generates and authorizes outreach actions; it does not itself send email, SMS, or social messages. The delivery worker must require a valid authorization result, store the validation run ID, and enforce uniqueness on the returned idempotency key before calling any communication provider.

## Run Tests

```bash
npm test
```

Tests cover normalization, deduplication, scoring, stale records, opt-outs, CRM synchronization, email enrichment, personalized email generation, signature enforcement, prohibited claims, pipeline persistence, queue controls, fail-closed behavior, and idempotency.

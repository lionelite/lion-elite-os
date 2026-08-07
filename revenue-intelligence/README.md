# LionOS Revenue Intelligence Engine (RIE v1)

## Purpose

Turn revenue, pipeline, and system-health data into one daily operating decision: **what should Lion Elite do next to generate revenue?**

This module implements the executable Phase One foundation from `docs/LION-ELITE-REVENUE-OPERATING-SYSTEM.md` and issue #90.

## What v1 calculates

- Revenue today, yesterday, last 7 days, and month to date
- $100,000/month target progress
- Daily target and required remaining daily pace
- Month-end revenue projection
- Orders and average order value
- Repeat-customer revenue share
- Revenue by brand
- Revenue by source
- Attribution coverage
- Weighted pipeline value
- Due-today and overdue follow-ups
- Expected opportunity value
- System freshness and failure state
- Ranked revenue leaks
- Top five daily revenue actions

## Run

Pass a JSON file:

```bash
npm run revenue:report -- ./path/to/revenue-input.json
```

Or pipe JSON:

```bash
cat ./path/to/revenue-input.json | npm run revenue:report
```

JSON output:

```bash
REVENUE_REPORT_FORMAT=json npm run revenue:report -- ./path/to/revenue-input.json
```

## Input contract

```json
{
  "monthlyTarget": 100000,
  "timeZone": "America/New_York",
  "revenueEvents": [
    {
      "id": "order-123",
      "timestamp": "2026-08-07T13:00:00Z",
      "amount": 199.99,
      "brand": "LEW",
      "source": "email",
      "campaign": "reactivation-2026-08",
      "customerId": "customer-1",
      "isRepeat": true,
      "verified": true
    }
  ],
  "leads": [
    {
      "id": "lead-1",
      "name": "Example Clinic",
      "brand": "LEW",
      "source": "b2b-outbound",
      "status": "proposal",
      "owner": "alex",
      "nextAction": "Call decision maker",
      "nextActionDate": "2026-08-07T16:00:00Z",
      "estimatedValue": 4000,
      "leadQuality": 0.9,
      "email": "contact@example.com"
    }
  ],
  "systems": [
    {
      "name": "storefront-revenue-sync",
      "owner": "engineering",
      "lastSuccessAt": "2026-08-07T12:30:00Z",
      "qualifiedOutputCount": 12
    }
  ]
}
```

## Expected-value model

Each lead receives:

`expected value = estimated deal value × stage probability × lead quality`

Default stage probabilities are conservative and must be recalibrated against real close rates as outcome history grows.

## Progression path

RIE v1 is deliberately source-agnostic. The next progression is to feed this contract automatically from:

1. Storefront / payment events
2. Lion Elite Beauty subscription lifecycle
3. Existing PostgreSQL lead and rep data
4. Consent-gated email and SMS engagement
5. Ads Manager performance and spend
6. Social/content analytics

No unavailable source is treated as zero. Source adapters must expose freshness and failure state so stale data can be surfaced instead of silently corrupting executive decisions.

## Operating rules

- Revenue every day is the primary operating objective.
- Highest expected-value due/overdue opportunities outrank optional feature work.
- Lion Elite Wellness remains research-use-only in customer-facing execution.
- Lion Elite Beauty remains premium coaching.
- Revenue attribution must be repaired before paid acquisition is scaled.
- Outbound execution remains subject to consent, suppression, opt-out, platform, and channel requirements.

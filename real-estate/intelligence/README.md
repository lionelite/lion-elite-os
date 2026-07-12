# Lion Elite Real Estate Intelligence MVP

This module converts property leads into explainable acquisition decisions for Lion Elite's real-estate investment committee.

## What it does

- Normalizes on-market and off-market property leads.
- Scores seller motivation, equity, deal economics, physical condition, legal/municipal risk, market quality, and source confidence.
- Applies mandatory deal-killer gates before recommending a property.
- Produces an explainable `PURSUE`, `WATCH`, or `PASS` recommendation.
- Creates a role-based due-diligence checklist showing who must verify each fact.

## Lead sources to connect

Use licensed APIs, exports, or permitted integrations. Do not bypass access controls or scrape sites in violation of their terms.

1. County property appraiser and tax collector records.
2. County clerk foreclosure and lis-pendens records.
3. Municipal code-enforcement and permit records.
4. MLS through a licensed broker/data agreement.
5. PropStream, BatchLeads, DealMachine, or another contracted property-data provider.
6. Auction, REO, probate, and tax-deed feeds where lawful and licensed.
7. Direct seller submissions and broker referrals.

Every imported fact should retain:

- `source_name`
- `source_url` or source record ID
- `captured_at`
- `confidence`
- `verification_status`

## Run the scoring demo

```bash
node real-estate/intelligence/src/demo.js
```

Run tests:

```bash
node --test real-estate/intelligence/test/scoring.test.js
```

## Decision standard

A high score is not permission to buy. The investment committee should not approve a purchase until the following are independently verified:

- Seller authority and motivation.
- Legal unit count and zoning.
- Rent roll, leases, deposits, and tenant estoppels.
- Title, liens, open permits, and code violations.
- Insurance availability and realistic premium.
- General inspection plus specialist inspections where needed.
- Financing terms, guarantor obligations, liquidity, and reserves.
- Property-manager operating budget and market-rent opinion.

## Roles

| Workstream | Primary professional |
|---|---|
| Seller questions and offer strategy | Multifamily broker / acquisitions manager |
| Purchase contract, title, leases | Florida real-estate attorney |
| Building systems | Licensed multifamily inspector |
| Roof | Licensed roofing contractor |
| Electrical | Licensed electrician |
| Plumbing and sewer scope | Licensed plumber |
| HVAC | Licensed HVAC contractor |
| Termites/WDO | Florida-licensed pest inspector |
| Mold/moisture | Licensed mold assessor when indicated |
| Flood and wind exposure | Insurance broker + surveyor/engineer as needed |
| Rent and operating budget | Third-party property manager |
| Loan sizing | Commercial/DSCR lender |
| Tax and entity structure | CPA + attorney |

## Next integrations

- PostgreSQL persistence.
- CSV/API import adapters.
- Miami-Dade public-record verification jobs.
- Document upload and inspection-report extraction.
- Five-property comparison dashboard.
- Alerts for newly filed pre-foreclosures, tax delinquency, code violations, and high-equity absentee owners.

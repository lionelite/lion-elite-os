# FHA House-Hack Acquisition Model (Cleveland prototype → replicate)

Narrows the general distressed-property engine to the repeatable model:
**acquire a 2–4 unit (ideally 4) owner-occupied FHA property in Cleveland →
stabilize → extract/redeploy equity → replicate in Miami with a different
qualifying FHA borrower → graduate to conventional / DSCR / commercial.**

`src/fha-househack.js` scores a property for this exact strategy.
`npm run real-estate:fha` runs the demo.

## What it evaluates

| Signal | Why it matters to the model |
|---|---|
| **Unit count 2–4 (4 best)** | FHA multifamily caps at 4 units; more units = more rent covering the note and more scale toward Deal #2. |
| **FHA Self-Sufficiency Test** | **Required for 3–4 units.** 75% of total market rent must cover the full PITI. This is the #1 killer of 3–4 unit FHA deals — encoded as a hard gate. 1–2 units are exempt. |
| **House-hack position** | Owner lives in one unit; the others pay the mortgage. Reports the owner's net monthly housing cost (negative = lives free + cashflow). |
| **Distress** | Vacancy, code violations, pre-foreclosure, tax delinquency, absentee/tired owner — the motivated-seller signals that create the value-add spread. |
| **Equity spread** | ARV vs all-in basis. The bigger the spread, the more equity to fund Deal #2 (refi/HELOC/cash-out) later. |
| **FHA loan limit** | Loan must fit the county's FHA limit for the unit count. |

## Deal-killers (hard gates)

- Unit count outside 2–4.
- Loan above the FHA limit for that unit count.
- No owner-occupiable unit (FHA requires principal residence).
- Condition not FHA-financeable and not a 203(k) rehab candidate.
- Fails the Self-Sufficiency Test (3–4 units).

## Configuration — verify before you rely on it

`DEFAULT_CONFIG` ships the **2025 FHA floor** limits (low-cost areas, which
Cuyahoga County uses) and rough carrying-cost assumptions **for screening
only**. Before making an offer:

- **Confirm the FHA loan limit** for the county and year at HUD's official
  limit lookup. Limits change annually.
- The **PITI is a first-pass estimate**, not an underwriting quote — real
  MIP, taxes, insurance, and rate vary. Get a lender's number.
- The Self-Sufficiency Test uses **estimated** rents; the **appraiser** sets
  the market rent that actually governs the test.

Override any of it per deal:

```js
const { assessFhaHouseHack } = require('./src/fha-househack');
assessFhaHouseHack(property, { ...DEFAULT_CONFIG, market: 'Miami', county: 'Miami-Dade',
  loanLimits: { 2: 929850, 3: 1123900, 4: 1396800 }, interestRatePct: 0.068 });
```

## Compliance boundary

This tool screens **properties**. It does **not** determine borrower
eligibility. Every FHA purchase in the model requires a borrower who
**independently qualifies** and **genuinely occupies** the property as their
principal residence — verified with a lender, not here. Deal #2 uses a
different, independently-qualifying borrower (the general rule is one FHA
loan at a time). The model reuses process, systems, and — where legally and
financially supported — capital from Deal #1; it never assumes the Cleveland
down payment can be pulled back out until the numbers and lender
requirements support it.

## Next step to make it live

`filterFhaCandidates(properties, config)` takes any array of property
records. Point it at a real Cleveland 2–4 unit feed (MLS export,
distressed-lead list, county violation/tax-delinquency data) via
`src/import-csv.js` and it becomes live sourcing instead of demo data.

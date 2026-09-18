# `agency/` — Managed AI-development agency engine

We sell the business outcome; vetted contractors do most of the technical
delivery under our direction. This module is the machinery that makes that safe:
it qualifies the client, prices from their value, architects the build into
verifiable fixed-price tickets, scopes contractor access to the minimum, gates
payment behind quality control, and keeps the commercial channel ours.

Full operating model: **[`docs/ai-development-agency.md`](../docs/ai-development-agency.md)**

```bash
npm run agency:plan     -- --client agency/examples/cedar-roofing.json
npm run agency:proposal -- --client agency/examples/cedar-roofing.json
npm run agency:internal -- --client agency/examples/cedar-roofing.json
npm run agency:tickets  -- --client agency/examples/cedar-roofing.json
npm run agency:scope    -- "we also need a mobile app"

# state that survives the process exiting
npm run agency:plan     -- --client agency/clients/cedar-roofing.json --open
npm run agency:ledger   -- cedar-roofing
npm run agency:ledger   -- cedar-roofing --receipt 12600 --kind deposit --state won
npm run agency:portfolio
npm run agency:bench
npm run agency:ledger   -- cedar-roofing --suggest <ticketId>
npm run agency:ledger   -- cedar-roofing --assign <ticketId> --to <contractorId>
```

## Layout

| File | Role |
|---|---|
| `src/offer.js` | The one productized offer, its capabilities, priced add-ons, hard declines, target verticals |
| `src/qualification.js` | Sizes the revenue leak in money; qualifies or disqualifies; payback and ROI gates |
| `src/pricing.js` | Value-based price, margin/cost-cap/deposit gates, productized ceiling, cash-flow check |
| `src/delivery-plan.js` | Capabilities → milestones → acceptance tests → fixed-price contractor tickets |
| `src/access.js` | Per-ticket least-privilege tiers, the absolute never-grant list, compliance downgrades |
| `src/contractor.js` | Agreement gate before assignment; reserved commercial acts; message channel screening |
| `src/qc.js` | Blocking quality-control checklist; payment release derived from acceptance |
| `src/engagement.js` | Composes all of the above into one engagement plan |
| `src/proposal.js` | Client proposal, internal plan, contractor ticket bodies, plus the leakage guard |
| `src/ledger.js` | Engagement state machine with fail-closed transitions; records actuals |
| `src/ledger-store.js` | Local JSON persistence for clients and ledgers (gitignored) |
| `src/portfolio.js` | Weighted pipeline, cash vs contractor commitments, estimate accuracy |
| `src/bench.js` | Contractor roster, capacity ceilings, track record derived from the ledgers |
| `cli.js` | Read-only CLI over the above |
| `templates/` | Discovery call script; required-terms checklists for both agreements |
| `examples/` | Four worked clients, each exercising a different decision path |

## Properties worth knowing

- **Pure and offline.** No database, queue, network, or Render service. Every
  planning function is deterministic, so the same client file always produces the
  same plan and price. `ledger-store.js` is the only module that touches disk.
- **Client data never gets committed.** `agency/clients/` and `agency/ledgers/`
  hold client financials and our own margins, and are gitignored — contractors
  are granted `repo-branch` access by design, so committing them would route that
  data straight through the access tier built to prevent it.
- **It refuses.** `planEngagement()` returns `proceed: false` with reasons for a
  deal that should not happen; `buildDeliveryPlan()` and `assignTicket()` throw
  rather than emit something unsafe; `buildProposal()` throws if the document
  would leak internal cost; the ledger throws on an illegal state move, on
  accepting a milestone whose quality control is open, and on paying for work
  that was never accepted. The bench refuses an assignment to anyone unpapered,
  over capacity, or not cleared for that capability.
- **Generation only.** Nothing here sends, posts, invoices, or opens issues.

Tests: `agency/test/`, in the root `npm test`.

# Managed AI-development agency — operating model

The business: we sell a business outcome; vetted contractors do most of the
technical delivery under our direction. We remain responsible for discovery,
strategy, architecture, quality control, delivery, and results. Contractors are
the fulfilment department, not the product.

Implemented in `agency/`. Every rule below is enforced in code and covered by
tests in `agency/test/` (wired into the root `npm test`), because a margin rule
that lives only in a document is a rule that gets negotiated away in a sales
call.

**This is generation only.** Nothing in `agency/` sends email, posts, invoices,
or opens GitHub issues. It prints documents. Sending remains governed by the
existing gated paths and the hard limits in `CLAUDE.md`.

## The offer — one thing, deliberately

> We build AI systems that recover missed leads, automate follow-up, qualify
> prospects, schedule appointments, and show management exactly how much revenue
> the system produces.

Five capabilities (`agency/src/offer.js`). Four are required — a build without
capture, follow-up, qualification and reporting is not this offer. Reporting is
required specifically because a client who cannot see the revenue the system
produced does not renew a retainer.

Anything else is a priced add-on or a decline. `scopeGuard()` takes the
prospect's own words and returns which:

```bash
npm run agency:scope -- "we also need a mobile app for our field crews"
# ✗ Decline: Consumer mobile app development — different bench, different QA surface, unbounded scope.
```

Declines exist because each one destroys the model in a specific way — unbounded
scope, unbounded liability, or a skill set the bench does not have. Staff
augmentation is a decline because it sells hours instead of outcomes and inverts
the margin model.

### Target verticals

Businesses where one recovered customer is worth thousands: oil & gas services,
specialty contractors, private medical practices, logistics, commercial real
estate, financial firms. Each carries a typical customer value used to sanity-check
what a prospect reports, and compliance flags that propagate into the contractor
access plan — a medical practice's build cannot be staffed the way a roofer's can.

## Step 1 — Close the client

`agency/src/qualification.js` sizes the leak in money from discovery facts, then
qualifies or disqualifies.

**It is deliberately conservative.** Two discounts that an eager model omits:

- We recover **35%** of missed leads, not all of them. A lead that went cold
  three weeks ago is often gone.
- A recovered lead closes at **60% of the client's normal close rate**, because
  it is older and was already ignored once.

An inflated number closes a deal you cannot defend at the 90-day review, which
kills the retainer that is most of the lifetime value.

**Most businesses should not buy this.** Hard disqualifiers: customer value under
$1,000, inbound under 25/month, annual recoverable value under $30,000, no
engaged decision-maker, insisting on hourly billing, or demanding a revenue
guarantee. A blocker disqualifies regardless of how good everything else looks.

Missing facts produce `DISCOVERY`, not a quote — quoting on a guess is how you
underprice. A missing fact never masquerades as a failed floor.

## Step 2 — We architect

`agency/src/delivery-plan.js`. The part that is not delegable, because it is what
makes the delegation safe.

A ticket is only safe to hand over when it carries four things:

1. a narrow, single-purpose statement of work
2. objective acceptance criteria, testable without a conversation
3. a fixed price
4. the lowest access tier that can complete it

`buildDeliveryPlan()` **throws** if any ticket is missing one, if a milestone has
no acceptance test, or if the payouts do not sum exactly to the budget. A
malformed plan never reaches a contractor. We never ask a contractor to interpret
intent, so their output is verifiable and the cost is predictable.

Milestone 1 is always ours: discovery, architecture, the scope document with
explicit exclusions, and the acceptance test suite — written **before** any build
work starts.

## Step 3 — Contractors execute

Fixed-price milestones, never hourly (`agency/src/contractor.js`,
`agency/src/access.js`).

**Access is per-ticket, not per-person.** Four graduated tiers; a ticket declares
the lowest one that can complete it. An unrecognised resource request defaults to
deny, because an unassessed resource is an unassessed risk.

`NEVER_GRANT` is absolute and no ticket can override it. It covers two different
risks that are easy to conflate:

- **Security** — production data, production credentials, production deploy,
  merge rights, repo settings. It is our company on the contract.
- **Channel** — the client's inbox, billing portal, and any direct contact. A
  contractor with those can quote the next phase directly. That is not a security
  breach; it is the loss of the business.

Compliance flags tighten this further: PHI or financial PII caps every ticket at
`sandbox`, so contractors work against synthetic fixtures and never reach an
environment holding real records. A HIPAA engagement additionally requires an
executed BAA before assignment.

**Paperwork is a gate.** `assignTicket()` throws if the NDA, IP assignment,
non-solicit and contractor agreement are not signed — plus a BAA where required.
Code written before an IP assignment is signed is code we may not own, and
discovering that during a client's due diligence is a catastrophe.

### Quality control

`agency/src/qc.js` is the gate between "a contractor says it's done" and both the
client seeing it and the contractor being paid. This is the load-bearing part: we
are not reselling cheap labour, and what the client is buying is that someone
competent checked the work. If this gate is soft, the agency is an unreliable
middleman.

Ten blocking items. Unrecorded counts as not passed. Payment release is *derived*
from acceptance — there is no way to release payment with a blocking item open,
and the `acceptance-tests` item cannot be self-ticked while a test is
outstanding.

## Step 4 — We retain the margin

`agency/src/pricing.js`. The reference deal:

| | |
|---|---|
| Client pays | $20,000 |
| Contractor delivery | $5,000–$8,000 |
| Software / operating | $1,000–$2,000 |
| **Gross profit** | **$10,000–$14,000** |
| Plus management retainer | $2,000–$5,000 / month |

Every way that deal degrades is a rule:

- **Price from value, not cost.** `priceFromValue()` prices at 18% of year-one
  recoverable value. Pricing from estimated hours makes the price a function of
  *our* cost — which is how an agency charges $6,000 for a system worth $180,000/yr
  to the buyer.
- **Margin floor 50%**, target 60%. Below the floor the quote is blocked.
- **Delivery cost capped at 40% of price.** A high delivery estimate *raises the
  price* rather than eating the margin.
- **Deposit floor 50%.** We do not fund a client's build from our working capital.
- **Cash-flow check.** `checkCashFlow()` verifies the deposit covers every
  contractor payout falling due before the client's balance lands. Otherwise we
  are lending the client money at 0% and carrying the delivery risk.
- **ROI ceiling.** Never price above a third of year-one value, or the return
  story dies.

### The two gates that replaced a naive ROI test

A single "year-one ROI ≥ 3x" test rejects deals whose build pays back in two
months, because it counts twelve months of retainer as pure cost. Split in two:

- **Build payback ≤ 6 months** — the capital question, and the hard gate. It is
  also the persuasive number, so the proposal leads with it.
- **Year-one ROI ≥ 2x** across build plus retainer — the relationship question.
  Under 3x is a warning, not a block.

### Productized price ceiling

A value-based calculation on a high-volume client returns $130,000 for the same
fixed scope. Quoting that invites a procurement process, three competing bids,
and a custom-software expectation nobody scoped. Above **$45,000** the engine
clamps to the ceiling and raises `escalateToCustom` — the deal is real, but it is
not this product, and pricing it is an owner decision.

### Retainer too heavy for a small client

A $2,000/mo retainer on a client gaining $7,500/mo is 26% of the result and will
not renew. When the build's payback passes but combined ROI does not, the engine
re-quotes the build alone plus a **quarterly optimization package** instead of
killing the deal.

## Step 5 — We control the relationship

- The client contracts with our company. Contractors are not parties and are not
  named.
- Contractors sign confidentiality, IP assignment and non-solicitation before
  assignment.
- We own the code, documentation, accounts and deployment process. Production
  deploy and merge rights are never granted.
- Contractors do not quote, invoice, or communicate commercially with the client.
  `reviewContractorMessage()` pre-screens anything a contractor wants relayed and
  blocks rate quotes, direct payment paths, solicitations and channel redirects.
  Technical answers relay fine — it catches commercial content only.

### What each document may contain

Enforced mechanically, not by care:

| Document | Contains | Never contains |
|---|---|---|
| Client proposal | Their value case, scope, milestones, acceptance criteria, price, deposit, payback | Delivery cost, margin, contractor anything |
| Internal plan | Everything | — |
| Contractor ticket | The work, its acceptance criteria, their own fixed price, their access tier | Client name, client price, other tickets' prices |

`assertNoInternalLeakage()` runs on every client-facing document before it is
returned, checking both internal vocabulary and the engagement's own internal
dollar figures in raw and comma-formatted form. A future template edit cannot
quietly start leaking cost figures — `buildProposal()` throws instead.

## Commands

```bash
npm run agency:plan     -- --client agency/examples/cedar-roofing.json   # the decision
npm run agency:proposal -- --client <file>    # client-facing proposal (markdown)
npm run agency:internal -- --client <file>    # internal plan: margin, cash flow, access
npm run agency:tickets  -- --client <file>    # every contractor ticket body
npm run agency:plan     -- --client <file> --json
npm run agency:scope    -- "<what the prospect asked for>"
```

Worked examples in `agency/examples/`, each chosen to exercise a different path:

| Example | What it demonstrates |
|---|---|
| `cedar-roofing.json` | The reference deal: $21,000 build, $7,700 delivery, $1,600 operating, $11,700 profit at 55.7%, $2,000/mo retainer, 2.2-month payback |
| `summit-energy-services.json` | Value beyond the productized ceiling → clamped and escalated to the owner |
| `lakeside-dental.json` | PHI: every ticket forced to synthetic fixtures, BAA required, retainer restructured to quarterly |
| `corner-cafe-disqualified.json` | Correctly refused — no price, no scope, no proposal generated |

## Templates

`agency/templates/` — the discovery call script (collects exactly the fields the
engine needs), and the required-terms checklists for the contractor and client
agreements.

**The agreement templates are not legal advice and are not agreements.** They are
the terms an attorney needs to draft or review for the relevant jurisdiction.
`contractor.js` tracks *that* an agreement is signed; it cannot tell you whether
it is enforceable.

## Where this sits in the repo

A standalone module, like `real-estate/intelligence/` and
`business-scaling/founder-intelligence/`: pure functions, no database, no queue,
no Render service, no network. It shares the repo's house style — frozen
constants, fail-closed gates, an explicit blocker list instead of a silent
default — but shares no runtime with the outreach pipeline.

Deliberately **not** connected to the outreach send path. The agency engine
produces documents for a human to send; it holds no send capability at all, and
the hard limits in `CLAUDE.md` govern anything that would change that.

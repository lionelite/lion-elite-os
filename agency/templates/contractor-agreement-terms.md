# Contractor agreement — required terms

> **This is not legal advice and it is not an agreement.** It is the checklist of
> terms the operating model depends on, written so an attorney can draft or review
> the actual documents for the relevant jurisdiction. Do not send this file to a
> contractor as a contract. `agency/src/contractor.js` tracks *that* each
> agreement is signed; it cannot tell you whether the agreement is enforceable.

Contractors are tracked by the agreement ids below. `assignmentEligibility()`
blocks assignment until every required id has a `signedAt`, so the paperwork is
genuinely a gate and not a formality.

## `nda` — Confidentiality

- Covers client data, our architecture and methods, pricing, and the existence
  and identity of clients.
- Survives termination.
- Names what is *not* confidential (their own pre-existing skills, public
  knowledge) so the clause is defensible.

## `ip-assignment` — Work product assignment

The load-bearing one. Without it we cannot sell the code to the client.

- **Present assignment**, not a promise to assign later.
- Covers copyright, patent rights, and moral rights where waivable.
- Covers everything created in connection with the engagement, including
  anything made before signing but for this work.
- Obliges cooperation with registrations and assignment formalities.
- Requires disclosure of any third-party, open-source, or AI-generated material
  included, with its licence — we cannot warrant ownership of what we do not know
  about.
- No retained licence back to the contractor, and no right to reuse client-specific
  work elsewhere. Generic skills and general know-how are theirs.

## `non-solicit` — Non-solicitation

- No soliciting our clients for the defined period after the engagement ends.
- No soliciting our other contractors.
- **Non-solicitation, not a general non-compete.** They may keep working in this
  field for other people. Broad non-competes are unenforceable in many
  jurisdictions and asking for one costs you good contractors.

## `independent-contractor` — Engagement terms

- **Fixed price per accepted milestone.** No hourly rate anywhere in the
  document — an hourly clause reintroduces exactly the risk the model removes.
- Payment triggers on *our* written acceptance against the ticket's acceptance
  criteria. Name the acceptance process.
- Independent contractor, not an employee. No benefits, own tools, own schedule,
  own taxes.
- **No authority to bind us.** They cannot quote, contract, or commit on our
  behalf.
- **Channel control** (mirrors `RESERVED_TO_AGENCY` in `contractor.js`): no
  contacting, quoting, invoicing, or proposing work to the end client; all
  communication on the ticket.
- **Access limits** (mirrors `NEVER_GRANT` in `access.js`): access is per-ticket;
  no attempt to obtain production credentials or client data beyond the granted
  tier.
- No subcontracting without written approval.
- We may terminate a ticket; work accepted to that point is paid.

## Conditional agreements

### `baa` — Business Associate Agreement
Required before **any** contractor touches an engagement where PHI is in scope
(`private-medical`). Must be executed before assignment, not before go-live.

### `confidentiality` — Enhanced terms for regulated engagements
For `financial-services` and anything with `REG_RECORDKEEPING`: record retention,
audit cooperation, and breach-notification obligations.

## Before first assignment

Run `onboardingChecklist()` from `agency/src/contractor.js`. It ends with the two
items people skip: confirming they understand they are paid per accepted
milestone rather than per hour, and walking the reserved-commercial-acts list
explicitly. Both prevent a specific, predictable argument later.

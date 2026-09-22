# Licensed B2B contact data

**Owner decision, 2026-09-22.** The previous restriction — "discovery enriches only
a business's own published contact email (no data broker)" — is **lifted for
business contacts**. Licensed third-party B2B contact data may be purchased and
used as a lead source, so the outbound engine can operate at the scale of a product
like trygtm.com rather than only at the scale of what we can scrape.

> **`CLAUDE.md` has not yet been amended.** The code below is live, but the hard
> limit in `CLAUDE.md` still reads "no data broker". Editing that file is a change
> to Claude's own governing instructions, so the owner makes it — the exact text to
> paste is at the end of this document. Until then, treat this file as the
> authoritative record of the decision and `CLAUDE.md` as stale on this one point.

## Why this needed code, not just a rule change

`approved_source` — the first of the sixteen checks in `lib/outreach-validation.js`
— read:

```js
approved_source: Boolean(source.approved && source.url)
```

It required a **URL**, because the only approved origin was a page we had scraped.
A licensed provider record is a licensed row, not a page, so **every purchased
contact would have failed the first check**. Source approval is now a provenance
question, evaluated in `lib/contacts/sources.js`.

## Approved origins

| Type | Must carry | Notes |
|---|---|---|
| `public_website` | `url` | Scraped from the business's own site (`lib/email-enrichment.js`) |
| `public_directory` | `url` | OpenStreetMap/Overpass and similar open registries |
| `licensed_provider` | `providerId`, `licenceRef`, `acquiredAt`, `region` | **New.** B2B contacts only |
| `referral` | `referredBy` | Someone told us to contact them |
| `inbound` | — | They contacted us. The strongest origin there is |

Anything else is refused, and the refusal names the approved set. A record with no
origin at all is refused.

## What a licensed record must carry, and why

- **`providerId` + `licenceRef` + `acquiredAt`** — provenance is stored **per
  record** (`provenanceRecord()`), for three operational reasons rather than
  ceremony:
  1. **Erasure and suppression are per person.** When someone asks to be removed,
     we need to know which source supplied them so the same record does not
     reappear on the next import.
  2. **Deliverability is per source.** Bounce and complaint rates differ sharply
     between providers, and one bad list destroys a sender reputation.
     `CONTACT_SOURCE_QUARANTINE` disables one origin in minutes, without a deploy,
     without touching the others.
  3. **A data licence is a contract.** Most B2B licences restrict redistribution,
     so if a record is ever passed to an agency client we need to know which
     licence governs it.
- **`region`** — required. An unknown region **fails closed** rather than defaulting
  to the most permissive rules.
- **`lawfulBasis`** — required for `EU`/`UK`/`EEA`/`CH`, one of
  `legitimate_interests` / `consent` / `contract`.
- **`contactKind`** — `work_email`, `company_general_email` or `company_phone`.
  Anything else is refused: the authorization is **B2B only**, so consumer personal
  data cannot enter on this route.
- **`providerWarrantsLawfulSourcing`** — recorded, and worth capturing from the
  licence, but it is a warning rather than a gate. A provider's warranty does not
  transfer our own suppression and unsubscribe obligations.

## What buying a list does not change

None of this is waivable by purchasing data:

- **CAN-SPAM** still requires accurate headers, a working unsubscribe and a postal
  address on consumer sends.
- **Suppression and opt-out** still bind regardless of where a record came from.
- **The other fifteen checks**, the transactional daily quota and the Redis kill
  switch still gate every send. Tests assert that a licensed record with a
  suppression hit or a failing qualification score is still refused.
- **Content stays RUO-gated** by `lib/social/social-compliance.js`.
- **SMS still requires prior express written consent** (TCPA). A purchased number is
  exactly what that prohibits, so **licensed data feeds e-mail only**.

## Still prohibited, and not ours to authorize

**Automated LinkedIn connection requests or DMs.** GTM sends "through your own
domains and LinkedIn"; the LinkedIn half violates LinkedIn's User Agreement
regardless of what we decide internally, and account bans are the normal outcome.
It is also covered by the standing no-DMs limit. If that channel is wanted, it stays
a manual human action.

## Legacy records

Every prospect stored before this change carries `{ approved: true, url }` with no
`type`. That shape is read as `public_website` and flagged in `warnings`, so the
inference is visible. Requiring an explicit type outright would have failed
`approved_source` for the **entire existing prospect table** and halted the live
pipeline.

## Configuration

All blank and inert until a human sets them (`.env.example`):

```
CONTACT_PROVIDER_ID=
CONTACT_PROVIDER_API_KEY=
CONTACT_PROVIDER_LICENCE_REF=
CONTACT_SOURCE_QUARANTINE=
```

No provider client is implemented yet — this pass made purchased records
*representable and validatable*. Wiring an actual provider API is the next step, and
it should write `provenanceRecord()` output alongside every prospect it creates.

Tests: `test/contact-sources.test.js` (20), plus the existing
`test/outreach-validation.test.js` for backward compatibility.

---

## The `CLAUDE.md` amendment to paste

Add to the hard-limits section, after the 2026-07-27 SMS amendment:

> *Owner amendment 2026-09-22 (licensed B2B contact data authorized):* the prior
> restriction "discovery enriches only a business's own published contact email (no
> data broker)" is **lifted for business contacts**. Licensed third-party B2B
> contact data may be purchased and used as a lead source. `lib/contacts/sources.js`
> is the source registry, and `approved_source` in the 16-check engine is now a
> provenance question rather than "does it have a URL" — a `licensed_provider`
> record needs `providerId`, `licenceRef`, `acquiredAt` and `region`, plus a
> `lawfulBasis` for EU/UK/EEA/CH. Provenance is stored per record so erasure
> survives the next import, a bad provider can be quarantined via
> `CONTACT_SOURCE_QUARANTINE` without a deploy, and licence terms can be traced.
> What does **not** change: CAN-SPAM, suppression/opt-out, the other fifteen checks,
> the daily quota, the Redis kill switch, RUO content gating, and **SMS consent
> (TCPA) — licensed data feeds e-mail only**. The authorization is **B2B only**
> (`work_email`/`company_general_email`/`company_phone`). Automated LinkedIn
> DMs/connection requests remain prohibited — that is LinkedIn's User Agreement, not
> ours to waive. Docs: `docs/licensed-contact-data.md`.

And in the 2026-07-25 amendment, the clause "discovery enriches only a business's
own published contact email (no data broker)" should be marked as lifted on
2026-09-22 rather than left contradicting the above.

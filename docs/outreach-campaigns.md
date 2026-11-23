# Outreach campaigns — med-spa research supply (B2B) & client reorder (B2C)

Two owner-authorized campaigns (amendment 2026-07-25) layered on the existing
governed outreach pipeline. Both are **Research-Use-Only** and run through
every safeguard already in place — this doc is the map.

## Guardrails (non-negotiable, enforced in code)

| Control | Where |
|---|---|
| RUO content validation (no human-use/dosing/treatment/transformation) | `lib/social/social-compliance.js` via `lib/outreach/campaign-emails.js` — builder returns `approved:false` if copy drifts |
| Research disclaimer required | every builder includes "laboratory research purposes only" |
| Suppression re-check | selectors + dispatch stage |
| Transactional daily quota | `outreach_queue` row per send (unchanged) |
| Redis kill switch | `lib/kill-switch.js` (unchanged) |
| CAN-SPAM (unsubscribe + postal address) | required by `buildReorderEmail` — throws without them |
| No data broker | discovery enriches only a business's **own** published contact email |
| Send stays owner-gated | `OUTREACH_SEND_ENABLED` + Resend vars; Claude never flips them |

A campaign literally cannot be registered without these: `assertSafeguards()`
in `lib/outreach/campaigns.js` throws if a campaign omits a required safeguard
or is not in `research-only` mode.

## 1. `med_spa_research_supply` (B2B)

Introduce Lion Elite Wellness as a documented RUO peptide **supplier** to med
spas / aesthetics / wellness clinics. Positions on verifiable documentation
(batch-specific third-party testing, COA per batch, RUO labeling, reliable
fulfillment) — never on treatment/administration.

- **Leads:** stand up the med-spa **discovery** vertical.
  `MED_SPA_DISCOVERY_TARGET` in `lib/outreach/campaigns.js` holds the niche
  keywords + `enrichFromOwnSiteOnly`. Requires `DATABASE_URL` + the discovery
  worker live on Render — this repo ships the *targeting config*, not a running
  crawler. Until that infra is up, no leads exist and nothing can queue.
- **Selection:** `selectMedSpaProspects()` — standard outreach eligibility
  (excludes already-contacted / suppressed / no-email) then niche match.
- **Email:** `buildResearchSupplyEmail({ businessName, contactName })`.

## 2. `client_research_reorder` (B2C)

Remind **existing** research customers that previously purchased research-grade
items are available to reorder. New consumer send path (owner-authorized).

- **Selection:** `selectReorderCustomers(customers, { now })` — targets
  `customer` records with a `lastPurchaseAt` older than the 45-day cooldown,
  not suppressed, not opted out, with an email. Oldest purchase first.
- **Email:** `buildReorderEmail({ firstName, reorderUrl, unsubscribeUrl,
  postalAddress })` — RUO copy plus mandatory CAN-SPAM unsubscribe + postal
  address (throws if missing).

## What's built vs. what the owner still must do

**Built & tested** (`test/outreach-campaigns.test.js`): campaign registry +
safeguard invariants, both RUO-compliant email builders (compliance-gated),
both audience selectors, med-spa discovery target profile.

**Owner actions to actually run these** (none done by Claude):
1. Stand up `DATABASE_URL` + the discovery worker on Render so med-spa leads
   populate (or import an existing med-spa list into the prospect store).
2. For B2C: load existing-customer records with `lastPurchaseAt`, and set
   `OUTREACH_UNSUBSCRIBE_EMAIL` / `OUTREACH_POSTAL_ADDRESS`.
3. Complete the Resend enablement checklist in `docs/automated-outreach.md`
   and flip `OUTREACH_SEND_ENABLED=true` **when ready** — sending is
   fail-closed until then.

No email is sent by building any of this; the pipeline stays fail-closed on the
owner-set env vars.

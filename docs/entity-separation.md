# Legal entity separation

Status: **enforced framework, one entity still inert.** Code:
`lib/entities/registry.js`, tests `test/entity-separation.test.js` (in the root
`npm test`). Companion to `docs/clinic-testing-requirements.md`, which defines
the two postures this framework assigns.

Not legal advice. Entity structure, and which posture each entity carries,
should be confirmed by counsel.

## Why this exists

Lion Elite Wellness sells Research-Use-Only material to research buyers. The
clinic-supply LLC (in formation, 2026-09-15) serves clinics and med spas, sources
US-based material only, and supplies into 503A/503B compounding. Two customers,
two postures, two sets of things that may be said.

Before this, they would have shared one prospect table, one suppression list,
and one from-address — which is not two entities, it is one entity with two
logos. The failure is concrete and one query away: `med_spa_research_supply`
already targets med spas under an RUO research pitch. The clinic-supply entity
targets the same businesses under a different posture. Absent a boundary, the
same contact receives both, and what the recipient experienced was not two
companies — it was one company saying two different things about the same
material.

## What is enforced

| Guard | Function | Effect |
|---|---|---|
| A campaign sends as a declared entity | `assertSafeguards` | A campaign without `entityId` cannot be registered |
| A campaign inherits its entity's compliance mode | `assertSafeguards` | A campaign cannot pick its way out of the RUO gate |
| A prospect belongs to the entity that acquired it | `assertProspectEntity` | `ENTITY_MISMATCH` on a cross-entity send |
| Consent is given to a company, not an operator | `assertConsentScope` | `CONSENT_ENTITY_MISMATCH`; under TCPA this is not discretionary |
| Suppression lists cannot merge | `suppressionKey` | Keys namespaced `suppression:<entityId>:<identifier>` |
| Each entity has its own sending identity | load-time check | Two entities sharing a from-address is a startup failure |
| A forming entity does nothing | `assertSendable`, `assertPostureMatch` | No sends, no release records |
| A release record matches its holder's posture | `assertPostureMatch` | `POSTURE_MISMATCH` |

The database carries it too: `prospects.entity_id` and
`outreach_queue.entity_id`. The queue row takes its entity **from the stored
prospect row, never from the caller** — the same principle as
`clinician_verified_by` in the coaching credential. A self-reported sending
entity is not an attribution.

## Why the LLC is registered but inert

`clinic_supply_llc` is in the registry with `status: 'forming'` and empty
`legalName`, `formationState`, and `registeredAddress`. Those are facts about a
company, and they get entered when the company exists. Per
`credentials/README.md`: nothing here invents a credential.

Until they are filled and the status flips, `describeSendability` reports:

```
entity status is "forming" — only an active entity may send
legalName is not recorded
formationState is not recorded
registeredAddress is not recorded
CLINIC_SUPPLY_FROM_EMAIL is not set
complianceMode "clinical-supply" is not implemented in lib/social/social-compliance.js,
  so every piece of this entity's copy would be blocked as unknown_compliance_mode
```

Flipping `status` to `active` is an owner action, the same shape of decision as
`OUTREACH_SEND_ENABLED`. Claude does not flip it.

### The compliance-mode gap (closed 2026-09-18)

`assertEntityShape` refuses to register an *active* entity whose compliance mode
has no rules behind it, while allowing a *forming* one to declare it — so the
gap was recorded and enforced rather than left as a comment. `clinical-supply`
is now written (see below), and `describeSendability` no longer reports it. What
remains outstanding for this entity is not code: it is a company that does not
exist yet.

## Activation checklist

Nothing below is autonomous; each line is an owner or counsel action.

1. **Form the entity** and record `legalName`, `formationState`,
   `registeredAddress` in `lib/entities/registry.js`.
2. **Confirm the posture with counsel**, per substance — see
   `docs/clinic-testing-requirements.md`. An entity holding
   `api_for_compounding` whose products are not eligible for compounding has
   nothing it can lawfully sell.
3. ~~Write the `clinical-supply` compliance mode.~~ **Done** — see below.
   Confirm `CLINICAL_SUPPLY_AUDIENCE_PHRASE` with counsel before first send.
4. **Set the sending vars** in the Render dashboard:
   `CLINIC_SUPPLY_FROM_EMAIL`, `CLINIC_SUPPLY_REPLY_TO`,
   `CLINIC_SUPPLY_POSTAL_ADDRESS`, `CLINIC_SUPPLY_UNSUBSCRIBE_EMAIL`. A separate
   verified sending domain, not a Wellness alias — the from-address is the only
   place the recipient can see which company is writing.
5. **Flip `status` to `active`.**
6. **Drop the `entity_id` defaults.** `db/schema.sql` adds the columns
   `NOT NULL DEFAULT 'lion_elite_wellness'`. That default is correct today — every
   prospect predating the column was acquired by Wellness, and no second entity
   can send. Once one can, the default becomes a way for a forgotten insert to be
   silently attributed to Wellness:

   ```sql
   ALTER TABLE prospects ALTER COLUMN entity_id DROP DEFAULT;
   ALTER TABLE outreach_queue ALTER COLUMN entity_id DROP DEFAULT;
   ```

7. **Re-acquire contacts deliberately.** An existing Wellness prospect does not
   become a clinic-supply prospect by changing a column. It needs its own
   acquisition and its own consent under the second entity —
   `assertProspectEntity` refuses the shortcut, which is the point.

## What is not built

- **No clinic-supply campaign exists.** `campaignsForEntity('clinic_supply_llc')`
  returns `[]`, and a campaign cannot be registered for it until step 3 above.
- **SMS is partly scoped.** `selectSmsRecipients` now takes an optional
  `entityId` and skips a recipient whose consent was given to a different entity
  as `consent_other_entity`, checked before opt-out and every other
  per-recipient gate — the send was never this entity's to make. Omitted, its
  behaviour is unchanged. A consent record with no entity recorded predates
  separation and is not treated as a mismatch; skipping those would make every
  existing consent permanently unusable.

  What is NOT done: SMS campaigns do not yet declare an `entityId`, so nothing
  passes that parameter in production yet. That step is blocked on the open
  question below, not on effort.
(The send path guard listed here previously is now wired — see below.)

## The send path (wired 2026-09-17)

`workers/outreach-worker.js` enforces the boundary at both points a message can
reach `lib/email-delivery.js`:

**Validation stage**, before the queue row is created: the prospect's entity is
checked against the registered campaign driving the send. Campaign ids that are
not governed campaigns — the Bluesky lead campaigns, for instance — are read as
"no campaign asserting an entity" rather than as an unknown-campaign error, so
lead-store prospects are unaffected.

**Dispatch stage**, the last gate before the one real send path: the entity is
re-resolved rather than trusted from the job payload, because the follow-ups
scheduler injects dispatch jobs directly and bypasses validation entirely.
`assertSendable` then returns the addresses that entity sends under, and
`sendEmail` uses them.

Ordering in dispatch is deliberate and pinned by a test:

1. kill switch — a halted queue parks without error and stays resumable;
2. entity check — an unsendable entity fails **before** the row is marked
   `processing`, so the item also stays resumable;
3. `markQueue('processing')`, then the send.

`sendEmail` now takes an optional `identity`. Without one it reads the
environment exactly as before — single-entity behaviour is byte-identical. With
one, every address comes from that entity and **none falls back to the
environment**: a second entity with no reply-to configured falls back to its own
from-address, never to Wellness's. That non-fallback is the entire reason the
parameter exists, and it has its own test.

### One operational consequence

If an entity is registered but not yet configured to send, its queued items fail
at dispatch with `ENTITY_NOT_SENDABLE` and stay `pending`, so the follow-ups
scheduler retries them on each run until the entity is configured. That is the
intended fail-closed shape — the same as the kill switch parking items — but it
does mean a half-configured entity produces a repeating failure in the job log
rather than a single one. The message names exactly what is missing.

## The clinical-supply compliance mode (written 2026-09-18)

`lib/social/social-compliance.js`, tests in `test/social-compliance.test.js`.

This mode is an **inversion** of `research-only`, not a relaxation of it. The
audience is a licensed professional buyer — not a consumer, and not a
researcher — and the two modes must never be swapped:

- **Research-Use-Only language is blocked here, not required.** Material sold to
  be compounded into a human medicine cannot also be labelled "not for human
  use". That contradiction is exactly what gets cited. A test asserts the same
  sentence passes `research-only` and fails `clinical-supply`.
- **A bare specification quantity is legitimate.** "30 mg vial", "net content
  31.30 mg" is spec text for a bulk substance, so the `research-only` rule that
  blocks every `\d+ mg` is deliberately not reused. Dosing is caught by
  dosing-*shaped* language instead.

| Rule | Blocks |
|---|---|
| `research_use_language` | RUO / research-grade / not-for-human-use phrasing |
| `patient_directed_language` | Consumer second-person and outcome copy |
| `dosing_or_administration_guidance` | Doses, titration, routes, reconstitution — directing clinical use is the prescriber's and compounder's role, never the supplier's |
| `unsubstantiated_eligibility_claim` | "approved for compounding", "on the bulks list", "503B-compliant" — that determination lives in a release record's `regulatoryBasis`, set by counsel, not in a marketing sentence |
| `fda_endorsement_implication` | "FDA-endorsed", "approved by the FDA", "FDA-registered *product*" |

`SHARED_RULES` still run first, so efficacy claims, "FDA-approved", "clinically
proven", guarantees and cure language are already blocked before these apply.

**"FDA-registered facility" stays allowed** — the registration belongs to the
facility and that is a fact. The same words attached to a product are not, and
are blocked. There is a test for each side of that line.

Copy must also carry an audience restriction (`CLINICAL_SUPPLY_AUDIENCE_PHRASE`,
currently "licensed pharmacies and outsourcing facilities"), the structural
analogue of the RUO disclaimer in research mode. **The exact wording is a
placeholder for counsel to confirm.** The requirement that *some* audience
restriction be present is the part that should not move.

## Lion Elite Beauty (resolved 2026-09-18: separate legal entity)

Owner decision: Beauty is its own legal entity, not a brand inside Wellness. It
is registered as `lion_elite_beauty`, `active`, with a third posture —
`cosmetics_and_coaching`, covering MoCRA cosmetics plus clinician-delegated
coaching services (the two record types in `credentials/README.md`).

Each posture pins its compliance mode in both directions, so a brand cannot pick
another's ruleset by editing one line:

| Posture | Required mode |
|---|---|
| `ruo_research_supply` | `research-only` |
| `cosmetics_and_coaching` | `coaching` |
| `api_for_compounding` | `clinical-supply` |

Beauty has no e-mail campaign yet, so `BEAUTY_FROM_EMAIL` and friends are unset
and `describeSendability` says so. That is accurate, not a gap.

## SMS is entity-scoped (2026-09-18)

**Consent.** `selectSmsRecipients` takes an `entityId` and skips a recipient
whose consent was given to a different entity as `consent_other_entity`,
checked *before* opt-out, suppression and every other per-recipient gate — a
text to someone who never consented to this company was never this entity's to
send. A record with no entity recorded predates separation and is not treated as
a mismatch; skipping those would make every existing consent permanently
unusable.

**Campaigns.** Every SMS campaign declares an `entityId` and inherits that
entity's compliance mode. `client_research_reorder_sms` sends as Wellness
(`research-only`); `coaching_welcome_sms` sends as Beauty (`coaching`). The old
`ALLOWED_COMPLIANCE_MODES` allow-list is gone — a campaign no longer picks its
mode from a list, it inherits it from the company sending it.

**Origination.** Each entity declares its own `smsFromEnvVar`, and two entities
sharing one is a startup failure, exactly like a shared from-address. This is
not a preference: **A2P 10DLC brand registration is tied to a legal entity's
EIN**, so an entity texting from another entity's registered number is sending
under someone else's carrier registration. Wellness keeps the existing shared
`TWILIO_FROM_NUMBER` so its behaviour is unchanged; Beauty needs
`BEAUTY_TWILIO_FROM_NUMBER` before `coaching_welcome_sms` can send, and
`runWelcomeCampaign` blocks with that exact message until it exists. A dry run
skips the check, like it skips credentials, so selection and copy stay
inspectable.

E-mail and SMS sendability are independent: Beauty having no e-mail address
configured does not block its texts, and a configured number does not imply a
configured address.

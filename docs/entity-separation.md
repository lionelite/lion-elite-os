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

### The compliance-mode gap is real work, not a checkbox

`lib/social/social-compliance.js` implements `research-only` and `coaching`. It
fails closed on anything else, so `clinical-supply` currently blocks **all** of
the LLC's copy as `unknown_compliance_mode` — safe, but it would look like a bug
at the point of use. So `assertEntityShape` refuses to register an *active*
entity whose mode has no rules, while allowing a *forming* one to declare it.
The gap is recorded and enforced rather than left as a comment.

Writing that mode is a genuine open question, not a copy-paste: RUO language is
wrong for a bulk drug substance sold to a licensed pharmacy, and consumer
human-use language is wrong in the other direction. It is B2B regulatory and
technical copy with its own rules, and it needs drafting before the entity can
speak.

## Activation checklist

Nothing below is autonomous; each line is an owner or counsel action.

1. **Form the entity** and record `legalName`, `formationState`,
   `registeredAddress` in `lib/entities/registry.js`.
2. **Confirm the posture with counsel**, per substance — see
   `docs/clinic-testing-requirements.md`. An entity holding
   `api_for_compounding` whose products are not eligible for compounding has
   nothing it can lawfully sell.
3. **Write the `clinical-supply` compliance mode** in
   `lib/social/social-compliance.js` and add it to
   `SUPPORTED_COMPLIANCE_MODES`.
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
- **SMS** (`lib/sms/*`) is not yet entity-scoped. It has its own consent model
  and the TCPA consequences of getting entity scope wrong are worse than for
  e-mail. Not attempted here rather than half-done — it needs the same treatment
  before any second-entity SMS is contemplated.
- **The send path does not yet call `assertProspectEntity`.** The guard, the
  columns, and the tests exist; wiring it into `workers/outreach-worker.js`
  changes live dispatch behaviour for a pipeline that is authorized to send
  unattended, so it is a deliberate separate step rather than a rider on this
  one. Nothing can currently trip it — there is only one sending entity — but it
  must be wired before there are two.

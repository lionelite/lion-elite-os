# Product credentials

"Credentials" here means the documentary evidence that makes a product
defensible to a customer, a platform reviewing an ad, or a regulator: a
certificate of analysis for a research peptide, a safety dossier for a
cosmetic, a licensed clinician's attestation behind a coaching protocol.

Three product lines sit under three different regimes. They are not
interchangeable, and applying one line's rules to another is the most common
way this goes wrong.

| Line | Product | Regime | Record | Validator |
|---|---|---|---|---|
| Lion Elite Wellness | Research peptides | Research-Use-Only chemicals | Certificate of Analysis, per lot | `validatePeptideCoa` |
| Lion Elite Beauty | Skincare | Cosmetics | Safety & identity dossier, per product | `validateSkincareDossier` |
| Lion Elite Coaching | Peptide protocols | Clinical, delegated to a licensed clinician | Clinician credential + consent, per protocol | `validateProtocolCredential` |

Templates are in `credentials/templates/`. Validation is
`lib/credentials/validate.js`, covered by `test/credentials.test.js`.

## The one rule that matters most

**Nothing in this directory invents a credential.** No lab name, lot number,
purity figure, licence number, assessor, or test result is generated. Every
value comes from the third party that issued it and is entered as data.

A fabricated certificate is not a shortcut to credibility — it is a fabricated
record, and it converts a compliance question into a fraud question. If a value
is not known yet, it stays empty and the record stays invalid. That is the
intended behaviour, not a gap to work around.

Every validator therefore **fails closed**, matching `OUTREACH_SEND_ENABLED`,
`SMS_SEND_ENABLED`, and the `clinician_confirmed` publish gate: a record is
invalid until it is complete.

## Research peptides — Certificate of Analysis

One per **lot**, not per product. A COA describing a different lot is not
evidence about the lot you shipped.

Required: `productId`, `productName`, `lot`, `manufactureDate`, `retestDate`,
`purityPercent`, `purityMethod` (HPLC), `identityMethod` (MS), `appearance`,
`storage`, and the issuing lab's `name`, `reportId` and `reportDate`.

Enforced beyond presence:

- **Purity ≥ 98%** to release. Below that the validator rejects the lot.
- **`retestDate` must be in the future.** A lapsed retest date means the lot is
  no longer represented as current, whatever the certificate once said.
- **`researchUseOnly` must be `true`.** This is the whole legal posture of the
  line and the thing every piece of Wellness copy is gated on
  (`lib/social/social-compliance.js`, research-only mode).
- **`claimsThirdPartyTested` requires `lab.independent === true`.** An in-house
  result is still a result, but only a third party's substantiates a
  "third-party tested" claim. Conflating them makes the claim false.

The RUO posture is not only a label. It is why Wellness copy may not carry
dosing, human-use, or transformation language at all — the compliance validator
blocks it, and that is upstream of anything written here.

## Skincare — safety and identity dossier

A different regime with different binding constraints: ingredient disclosure,
a safety assessment, and substantiation for every claim.

Required: `productId`, `productName`, a non-empty `inci` array in descending
concentration order, `allergensDeclared` (use `[]` to assert none), `batchCode`,
`periodAfterOpeningMonths`, a complete `safetyAssessment` (assessor, credential,
date, report id), and `manufacturing.facility` plus `gmpStandard` (ISO 22716).

Enforced beyond presence:

- **MoCRA facility registration and product listing must both be `true`** to
  market in the US. These are statutory, not best practice.
- **Every claim needs `substantiation`.** An unsubstantiated claim fails.
- **Every claim is run through the compliance validator in coaching mode.** A
  cosmetic that claims to treat a condition is, by claim, a drug.

### The peptide-in-skincare trap

Copper peptides, matrixyl, and similar actives are ordinary skincare
ingredients — but `brand_separation` in `lib/social/social-compliance.js`
blocks the word "peptide" on the Beauty brand entirely, to keep research
compounds on the Wellness side of the line.

So a serum containing GHK-Cu cannot be *marketed* using the word, even though
the ingredient is legitimately in the INCI list. The dossier validator surfaces
this at claim-authoring time rather than in a rejected campaign. Two honest ways
through, both an owner decision:

1. Describe the active by its INCI name and its effect without the category
   word. The INCI list stays accurate; the marketing copy avoids the term.
2. Revisit the brand-separation rule deliberately, if the Beauty line now
   genuinely sells peptide cosmetics. That is a real change to the brand
   posture and should be made on purpose, not by loosening a regex.

Option 1 needs no code change. Option 2 must not be done casually — the rule
exists so RUO research compounds never appear in consumer transformation copy.

## Coaching peptide protocols — clinician credential

The highest-liability record here, and the thinnest one today.

`coaching_peptide_protocols` already refuses to publish without
`clinician_confirmed = true`, enforced by a database CHECK:

```sql
CHECK (status <> 'published' OR clinician_confirmed = true)
```

That is a good control, and it is a **boolean**. It records that someone ticked
a box. It does not record who, under what licence, in what state, whether the
licence was current, who checked it, or whether the client consented.

This record is the evidence that tick stands on: clinician name, licence type,
licence number, licence state, NPI, expiry, who verified it and when, plus the
informed-consent date and document id.

Enforced beyond presence:

- **An expired licence is rejected.**
- **`scope` must be `clinician_directed`.** A coach does not prescribe. A record
  claiming otherwise is refused outright rather than stored.

### Known gap

The database stores `clinician_name` and `clinician_confirmed` and nothing else.
None of the fields above have a column. Until they do, this record has no home
in Postgres and the validator can only be run against a file.

Closing that gap means adding the columns and writing the credential at publish
time. It is a schema change with real liability behind it and is deliberately
**not** done here — flagged for an owner decision rather than assumed.

## Not legal advice

This encodes commercial and regulatory practice as it applies to these three
lines. It is not legal advice, and the MoCRA, RUO, and scope-of-practice
positions in particular should be confirmed by a qualified professional before
anything ships to customers.

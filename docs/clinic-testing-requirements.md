# Clinic and med-spa supply — testing requirements

Status: **decision record + enforced spec.** Code:
`lib/credentials/clinic-channel.js`, template
`credentials/templates/clinic-supply-record.json`, tests
`test/clinic-channel-credentials.test.js` (in the root `npm test`).

This extends `credentials/README.md`, which covers the Research-Use-Only
certificate of analysis. Read that first — the rules there still apply.

**Not legal advice.** The 503A/503B positions below are the commercial reality
as generally understood and must be confirmed by regulatory counsel before any
material moves. The code records counsel's determination; it does not make it.

## The question this answers

The owner's position (2026-09-15): a certificate of analysis covering identity,
purity, endotoxin, microbial contamination, elemental impurities, and net
content is all the testing needed to sell to clinics — a new LLC serving
clinics and med spas only, sourcing only US-based material, 503 only.

That is **correct for one of the two ways to sell to a clinic, and not the
other.** The panel is not the variable. The posture is.

## Two postures, and why they cannot be blurred

`validateClinicSupplyRecord` requires every record to declare one.

### `ruo_research_supply`

The clinic buys as a research customer. The material stays Research-Use-Only,
the human-use disclaimer stands, and nothing about the sale represents the
material as suitable for administration.

**Under this posture the owner's position is right: the existing panel is
sufficient.** No new testing is required. `test/clinic-channel-credentials.test.js`
pins this — a record carrying exactly the current panel validates.

What it costs: no clinical representation, in any channel. The certificate
itself carries the constraint, in its own footer:

> The peptides tested are intended for research use only and are not for human
> or veterinary use, diagnostic, therapeutic, or clinical applications.

A sale conducted on that document while describing clinical use contradicts the
document. `clinicalUseRepresented: true` under this posture is a hard error.

### `api_for_compounding`

The material is sold as a bulk drug substance to a 503A pharmacy or a 503B
outsourcing facility, which compounds and dispenses it. This is drug supply.
It needs a fuller release panel, an FDA-registered cGMP manufacturer, and one
thing no certificate can supply at any purity:

**Bulk drug substance eligibility.** A pharmacy may only compound from a
substance that has a USP/NF monograph, is a component of an FDA-approved drug,
or appears on the FDA bulks list for that pathway. That is a property of the
**substance**, not of the lot. An investigational compound that is none of the
three is ineligible however clean the material is — 99.99% purity does not
change it.

This is the load-bearing point for the product on the certificate reviewed
below. **Retatrutide (Lilly LY3437943) is an investigational drug** — as of this
writing it is not FDA-approved, has no USP monograph, is not a component of an
approved drug, and is not on the 503A or 503B bulks list. On that basis a 503
pharmacy cannot lawfully compound it, and the blocker is not testing. Confirm
the current status with counsel; it is the first question to ask, before any
lab work is commissioned.

`validateBulkSubstanceEligibility` therefore fails closed on three booleans
that all default to `false`, and records who determined otherwise and when.

## The panel, by posture

`RELEASE_TESTS` in `lib/credentials/clinic-channel.js` is the source of truth.

| Test | Method | RUO research supply | API for compounding |
|---|---|:--:|:--:|
| Identity | LC-MS | ✓ | ✓ |
| Purity | HPLC-UV | ✓ | ✓ |
| Appearance | visual | ✓ | ✓ |
| Endotoxin | LAL, USP \<85\> | ✓ | ✓ |
| Microbial | PCR or USP \<61\>/\<62\> | ✓ | ✓ |
| Elemental impurities | ICP-MS, USP \<232\>/\<233\> | ✓ | ✓ |
| Net content | gravimetric | ✓ | ✓ |
| **Peptide content (assay)** | AAA or quantitative HPLC | — | ✓ |
| **Related substances** | HPLC | — | ✓ |
| **Water content** | Karl Fischer, USP \<921\> | — | ✓ |
| **Residual solvents** | GC, USP \<467\> | — | ✓ |
| **Counterion** | ion chromatography | — | ✓ |
| **Bioburden** | USP \<61\> | — | ✓ |

Plus, under `api_for_compounding` only: an expiry date in the future, an
accredited and independent lab, and a US-based cGMP manufacturer with an FDA
establishment registration number.

### Three panel notes worth knowing

- **Endotoxin pass is not sterility.** LAL measures bacterial endotoxin. It says
  nothing about viable organisms. Sterility is USP \<71\>, and it applies to the
  finished sterile preparation — which, in the compounding model, the 503B does,
  not us. It is deliberately not on the table above for that reason. If the LLC
  ever fills finished vials itself, that changes and \<71\> becomes ours.
- **Microbial PCR is not a compendial microbial limits test.** "No detectable
  microbial DNA" is a good signal and a real test, but it detects nucleic acid,
  not viable count. A compounding pharmacy's incoming-material review expects
  USP \<61\>/\<62\> bioburden, which is why the API column adds it.
- **Net content is not peptide content.** A lyophilised peptide's fill weight
  includes counterion (acetate or TFA) and residual water; actual peptide content
  is commonly 75–85% of the vial weight. A clinic dosing against fill weight is
  dosing against the wrong number. The validator flags
  `peptideContentPercent > purityPercent` as a likely conflation of the assay
  with chromatographic purity.

## The certificate reviewed (Freedom Diagnostics, lot FO859)

Retatrutide 30mg, accession 2609040469, reported 2026-09-06.

Strong for an RUO certificate — endotoxin in duplicate at ≤0.05 EU/mL
sensitivity, microbial PCR, and four-element ICP-MS are more than most research
suppliers publish, and 99.99% HPLC-UV with LC-MS identity confirmation is a good
result. Under `ruo_research_supply` the panel is sufficient.

Gaps against the validators as they stand:

| Field | Status | Required by |
|---|---|---|
| `manufactureDate` | absent (9/4 received and 9/6 reported are lab dates) | `validatePeptideCoa` |
| `retestDate` | absent — no retest or expiry anywhere on the document | `validatePeptideCoa`, and it must be in the future |
| `storage` | absent | `validatePeptideCoa` |
| `lab.independent` | not stated | needed for any "third-party tested" claim |
| `lab.accreditation` | not stated (ISO/IEC 17025 or equivalent) | `api_for_compounding` |

So **as printed this certificate does not pass the repo's existing
`validatePeptideCoa`** — on four fields, none of them a test result. They are
obtainable from the supplier rather than re-tested, and they are cheap to close.

One structural point: the client on the certificate is **Optima**, not us. It is
Optima's testing of Optima's lot. Passing it through to a customer as supply
documentation is normal and fine; presenting it as *our* testing is not, and it
is not a substitute for our own incoming release testing under the API posture.

## What to do next, in order

1. **Ask counsel the eligibility question first** — for each substance the LLC
   intends to supply, under 503A and 503B separately. It gates everything else,
   and it is answered from the substance, not the lot. Record the answer in
   `regulatoryBasis`.
2. **Close the four documentary gaps** with the supplier for every lot already
   held: manufacture date, retest/expiry date, storage conditions, and a written
   statement of lab independence and accreditation.
3. **Decide the posture per product, explicitly.** Products that clear step 1 can
   move to `api_for_compounding` and need the fuller panel commissioned.
   Products that do not stay `ruo_research_supply` — sellable, but only as
   research supply, with no clinical representation anywhere in the funnel.
4. **Only then change any marketing.** `lib/social/social-compliance.js` blocks
   human-use, dosing, and transformation language on the Wellness brand. That
   gate is correct for the RUO posture and must not be loosened to accommodate a
   clinic channel that has not cleared step 1. If a product does clear it, the
   posture change is an owner decision made deliberately — as
   `credentials/README.md` puts it, on purpose, not by loosening a regex.

## Entity separation

The new LLC is a separate legal entity from Lion Elite Wellness. Nothing in this
repo models it yet — there is no entity field on a prospect, a campaign, a
product, or a credential record, and the outreach campaigns in
`lib/outreach/campaigns.js` (`med_spa_research_supply`) send as Wellness under
the RUO posture. If the two entities are to have different postures, that
separation has to become real in the data before a single send goes out under
the wrong one. Flagged, not built — it needs the owner's structure decision
first.

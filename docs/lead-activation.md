# Gated lead activation

Turns the Wellness storefront's gated-access signups into a prioritised,
compliance-checked outreach worklist.

## The problem this solves

`CustomerAccessGate` on the storefront collects name, email, phone and explicit
email/SMS marketing consent, then upserts a row into `member_leads` with
`status: 'new'`.

Nothing ever reads it again. A repo-wide search finds exactly two consumers:
the API route that writes leads, and an admin route that lists them. **No code
anywhere updates `status` or contacts anyone.** Every person who ticked the
opt-in box has been sitting untouched since the gate went live.

## Run it

```bash
npm run leads:analyze                          # live member_leads
node scripts/analyze-leads.js --drafts         # + ready-to-send welcome drafts
node scripts/analyze-leads.js --json
node scripts/analyze-leads.js --sample         # worked example, no database
node scripts/analyze-leads.js --limit=50
```

`--sample` needs no database or driver, so the report can be seen working before
anything is wired.

## What it reports

- **Contactable now** — opted in, valid contact details, not suppressed, never contacted
- Reach split by channel, and how many are reachable on both
- **Why each blocked lead is blocked** (`no_email_consent`, `invalid_email`,
  `unparseable_phone`, `suppressed`, …) — so the gaps are fixable rather than invisible
- Age buckets and **the oldest lead's wait in days**, which is the number that
  quantifies what is being lost
- Breakdown by capture source
- A prioritised worklist

## How prioritisation works

Priority favours people who opted in and have waited longest, since they are the
ones going cold. Two properties are deliberate and are covered by tests:

- **Age can never promote a non-consented lead.** The age contribution is capped
  below the consent contribution, so urgency cannot erode the legal gate.
- A **reachable** lead always outranks an unreachable one, no matter how old.

## Consent is a gate, not a preference

Emailing without opt-in is a CAN-SPAM problem; texting without prior express
written consent is a TCPA one. So:

- `emailReachable` requires `emailMarketingConsent === true`, a well-formed
  address, and no suppression match (case-insensitive).
- `smsReachable` requires `smsMarketingConsent === true` and a phone that
  normalises to E.164. A number that will not parse is reported as
  `unparseable_phone`, never guessed at.
- Leads that fail both are reported as `none_contactable` with reasons, never
  quietly upgraded.

## The welcome email

`gated_lead_welcome` in `lib/outreach/campaigns.js`, built by
`buildWelcomeEmail` in `lib/outreach/campaign-emails.js`. It is registered
through the same `assertSafeguards()` gate as every other campaign, so it cannot
skip compliance validation, suppression, the daily quota, the kill switch, or —
being a consumer send — unsubscribe and postal address.

The copy is a short personal note inviting a reply, not a product blast: a reply
is what moves someone to the next funnel stage. It is RUO-framed and run through
the fail-closed validator before it is returned. A build whose copy drifts into
human-use, dosing or outcome language comes back `approved: false` with blockers,
and the caller must not send it. A test proves this by injecting dosing language
through the first-name field.

`--drafts` refuses to build anything unless `OUTREACH_UNSUBSCRIBE_URL` (or
`_EMAIL`) and `OUTREACH_POSTAL_ADDRESS` are set, rather than producing a
non-compliant email.

## Reading the live table

`lib/leads/member-lead-source.js` reads `member_leads` over libSQL/Turso. Set one
of `MEMBER_LEADS_DATABASE_URL`, `TURSO_DATABASE_URL`, `LIBSQL_DATABASE_URL` (plus
an auth token if required) to the same database the storefront writes to.

Two deliberate behaviours:

- **Read-only.** LionOS never writes to the storefront's table, so an outreach
  bug cannot corrupt the signup record.
- **An unconfigured database throws** instead of returning an empty list. Zero
  leads would read as "nobody signed up", which is the opposite of the truth.

## What this does not do

It decides who *may* be contacted and drafts the message. **It does not send.**
Sending stays behind `OUTREACH_SEND_ENABLED` plus the Resend variables, and
flipping that switch remains an owner action.

## Next step

Emit `lead_created`, `consent_captured` and `welcome_email_sent` funnel events
(PR #93) as leads move, so the revenue report shows activation working rather
than requiring this report to be read separately.

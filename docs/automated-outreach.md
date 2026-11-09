# Automated Outreach — Unattended Sending, Safeguards, and the Kill Switch

**Owner decision (2026-07-19):** automated B2B partnership email through the
validated outreach pipeline is explicitly authorized to send **unattended**
— no per-email human approval. This document records that decision, the
safeguards that apply to every send, the kill switch, and the exact
enablement checklist.

## Safeguards on every send (none require a human)

| Safeguard | Where | What it does |
|---|---|---|
| 16-check fail-closed validation | `lib/outreach-validation.js` | Suppression, duplicate prevention, cadence, frequency limits, channel/campaign eligibility, data freshness, qualification threshold, message-version approval — any failure blocks the send |
| Draft quality gate | `workers/outreach-worker.js` (email stage) | Personalization score below `MINIMUM_PERSONALIZATION_SCORE` (default 56.25) or any content blocker → no send |
| Suppression re-check at enqueue | `lib/postgres-prospect-store.js` | A suppressed prospect cannot even be queued (transactional) |
| Daily quota | `daily_usage` table, enforced transactionally in `markQueue` | Hard cap per day (`DAILY_EMAIL_LIMIT`); both the `processing` and `sent` transitions check it |
| Queue-backed sends only | validation handler | Every send creates an `outreach_queue` row first — the quota ledger and audit trail cannot be bypassed (`PROSPECT_ID_REQUIRED` otherwise) |
| Dedupe | deterministic `idempotencyKey` (sha256 of prospect/campaign/step/version) as both the queue-row key and the BullMQ jobId, plus Resend's `Idempotency-Key` header | The same message can never double-queue, double-dispatch, or double-send |
| CAN-SPAM mechanics | `lib/email-delivery.js` | `List-Unsubscribe` header, reply-to, and (set `OUTREACH_POSTAL_ADDRESS`) a physical-address footer on every email |
| Env hard gate | `lib/email-delivery.js` | No `RESEND_API_KEY` + `OUTREACH_FROM_EMAIL` + `OUTREACH_SEND_ENABLED=true` → `sendEmail` throws before any provider call |
| Audit trail | `prospect_events` + structured logs | Every queue/status/send transition is recorded with actor and timestamp |

## The kill switch (instant, no redeploy)

`lib/kill-switch.js` stores a flag in Redis (`outreach:sending_halted`).
All three worker stages consult it: the follow-ups scheduler stops
dispatching, the validation handler parks items as `pending` without
dispatch jobs, and the dispatch handler completes **without sending**
(items stay `pending` and resume automatically). Fail-closed: if the flag
can't be read, sending halts.

```bash
# from any machine with REDIS_URL set (Render shell works):
node scripts/outreach-kill-switch.js status
node scripts/outreach-kill-switch.js halt "pausing while I investigate replies"
node scripts/outreach-kill-switch.js resume
# or via the executive API (requires EXECUTIVE_API_TOKEN — fails closed if unset):
curl -X POST https://<executive-api>/outreach/kill-switch \
  -H "Authorization: Bearer $EXECUTIVE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"halted": true, "reason": "manual stop"}'
```

Second, slower layer: set `OUTREACH_SEND_ENABLED=false` on
`lion-elite-outreach-worker` in Render (redeploy ~1 min). Use the Redis
switch for "stop right now", the env var for "stay off until I say so" —
in an emergency, flip both. The worker's health endpoint reports
`sendingHalted` so the state is always visible.

## "Reach out to all" — the governed enqueue

`scripts/enqueue-outreach.js` (`npm run outreach:enqueue`) feeds eligible
prospects into the validated pipeline. It is **not** a blast: selected
prospects still pass per-prospect 16-check validation and suppression, and
dispatch is metered by the daily quota + kill switch. "Reach out to all"
means "enqueue everyone eligible and let the worker send at the governed
daily pace," which unfolds over days — not one send.

```bash
npm run outreach:enqueue                     # DRY RUN — who would be contacted, and who's skipped + why
npm run outreach:enqueue -- --limit=15       # dry run, top 15 by score
npm run outreach:enqueue -- --confirm --limit=15   # actually enqueue the top 15
```

- **Dry run by default** — nothing is enqueued without `--confirm`.
- **Eligibility** (`lib/outreach-enqueue.js`): has an email, not suppressed,
  and not already contacted/terminal (`sent`/`engaged`/`customer`/… are
  skipped). Highest-scoring first, so a capped run reaches the best leads.
- **Refuses to run while the kill switch is engaged.**
- **Does not bypass the deliverability ramp** — run it at your daily cap
  (`--limit` = today's `DAILY_EMAIL_LIMIT`); the pipeline meters real sends.
- Requires `DATABASE_URL` + `REDIS_URL`, and of course sends nothing until
  the Resend vars below are set. The Bluesky listener's "leads" and inbound
  affiliate applicants are **not** in this path — they aren't cold-email
  targets.

## Enablement checklist

### In Resend (resend.com dashboard)

1. **Add and verify the sending domain** — use a subdomain, e.g.
   `mail.lionelitebeauty.com` (partnership outreach is the Beauty lane), so
   the root domain's reputation is insulated. Add the SPF and DKIM DNS
   records Resend shows you; wait for "Verified".
2. **Create an API key** (Sending access only, scoped to that domain if
   offered). Copy it once; it goes only into Render.
3. Recommended: enable open/click tracking off (partnership email reads
   better without tracking pixels) and set up the webhook later if bounce
   automation is wanted.

### In Render (dashboard → `lion-elite-outreach-worker` → Environment)

| Var | Value |
|---|---|
| `RESEND_API_KEY` | the key from Resend (secret — never in git) |
| `OUTREACH_FROM_EMAIL` | `Alexander <alex@mail.lionelitebeauty.com>` (match the verified domain) |
| `OUTREACH_REPLY_TO` | a monitored inbox — replies are the whole point |
| `OUTREACH_UNSUBSCRIBE_EMAIL` | e.g. `unsubscribe@mail.lionelitebeauty.com` (feeds the List-Unsubscribe header) |
| `OUTREACH_POSTAL_ADDRESS` | your business mailing address (CAN-SPAM requires it; a registered-agent or PO Box address works) |
| `DAILY_EMAIL_LIMIT` | **start at `15`**, not 100 — see ramp below |
| `OUTREACH_SEND_ENABLED` | `false` first; `true` only at step 4 below |

Also confirm `EXECUTIVE_API_TOKEN` is set on `lion-elite-executive-api`
(the kill-switch API refuses to operate without it).

### Go-live sequence

1. Deploy with `OUTREACH_SEND_ENABLED=false`; check the worker's `/ready`
   reports healthy with `deliveryConfigured: false`.
2. Create a test prospect using your own email address and let the
   pipeline run — confirm the queue row appears and nothing sends.
3. Test the kill switch once while still disabled: `halt`, confirm
   `status` and the worker's `sendingHalted: true`, then `resume`.
4. Set `OUTREACH_SEND_ENABLED=true`. Your test prospect's email should
   arrive: check the from-name, the unsubscribe header, the postal footer,
   and that the queue row shows `sent`.
5. Watch the first real week at `DAILY_EMAIL_LIMIT=15`, then ramp roughly
   15 → 30 → 50 → 100 week over week **if** bounces stay under ~3% and
   spam complaints at zero. Cold domains that jump straight to 100/day get
   junk-foldered — the ramp is deliverability protection, not caution
   theater.
6. Process every reply and unsubscribe request promptly (CAN-SPAM: opt-outs
   honored within 10 business days; in practice, same day — add them to the
   suppression list).

### Key rotation

Resend key: create new in Resend → update in Render → revoke old. Never
commit, echo, or paste keys anywhere but the Render env tab.

## Clinic campaign (med_spa_research_supply): qualification and the daily run

Added 2026-11-09. Discovery stores clinics as `osm-business-discovery`
prospects; the outreach worker now routes them to the clinic e-mail
(`lib/outreach/clinic-supply-email.js`) instead of the Beauty partnership
template, and qualifies each one immediately before validation
(`lib/outreach/clinic-qualification.js`).

Qualification derives every status the 16 checks read from evidence, and fails
the status when the evidence is missing. It does not change any threshold:

| Status | Passes only when |
|---|---|
| source | the record came from OpenStreetMap or the clinic's own website |
| identity | the inbox domain matches the clinic's website (no Gmail/Yahoo/...) |
| duplicate | no other record at the same organisation has been queued or sent |
| eligibility | the targeting tier is **high**; medium-tier clinics need a person to check the site |
| suppression | the address/domain is not on `outreach_suppressions` and the prospect is not suppressed |
| freshness | the contact was confirmed within 30 days |
| personalization / compliance | the draft passes its checklist and the RUO validator |
| cadence | the prospect has never been queued (first touch only, see below) |
| message version | the version id is in `OUTREACH_APPROVED_MESSAGE_VERSIONS` |

**Approving the copy is the owner's step.** `npm run outreach:versions` prints the
current version id and the text. Add the id to `OUTREACH_APPROVED_MESSAGE_VERSIONS`
on the outreach worker. Any edit to the template produces a new id, which is
unapproved until added.

**Daily run.** The `lion-elite-clinic-outreach` cron (weekdays 14:07 UTC) runs
`scripts/clinic-outreach-daily.js --confirm`: up to `OUTREACH_DAILY_NEW_CLINICS`
(default 20) new clinics, never more than the remaining `DAILY_EMAIL_LIMIT`, one
per organisation per day. It enqueues nothing unless the outreach worker's
heartbeat reports sending is configured, so it holds no send credential and
cannot mark clinics as contacted while nothing can be sent.
`npm run outreach:clinics` is the dry run: who would go today and why others would not.

**Opt-outs, bounces, earlier outreach.** `npm run outreach:suppress -- --email x --reason opt_out`
(also `--domain`, and `--csv <file>` which takes every address in the file).
Before the first live run, import the clinics already e-mailed by hand from Gmail
(the Drive master sheet's Outreach History) with `--reason prior_contact`, so
nobody receives a second, different introduction.

**Not automated yet: follow-ups.** E-mails 2 and 3 of the sequence need reply
detection, which does not exist. Without it an automated follow-up would reach
people who already replied. Until it is built, replies go to `OUTREACH_REPLY_TO`
and are handled by a person.

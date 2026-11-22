# Lion Elite Clinical outreach — operations

Architecture, ownership, configuration, runbook, and the verification record for
the clinic e-mail campaign (target and maximum: **150 provider-accepted
messages per America/New_York day**). Day-to-day HTTP details stay in
`docs/clinic-outreach-http.md`; discovery in `docs/clinic-discovery.md`.
No secrets appear here.

## 1. Who owns each step (verified 2026-11-22)

| Step | Owner | Where |
|---|---|---|
| Lead discovery | GitHub Actions runner (`clinic-discovery.yml`, every 2 h) → service `/run/clinic-discovery/*` | `scripts/discover-clinics.js`, `lib/discovery/*` |
| Canonical lead + send records | **Supabase** project `jovytlxkbxwgqhnirbiq` | `prospects`, `outreach_queue`, `prospect_events`, `outreach_suppressions`, `daily_usage`, `outreach_runs`, `clinic_discovery_runs` |
| Send scheduling | **Supabase pg_cron** job `clinic-outreach-send` (the only scheduled sender) | `db/supabase/clinic-outreach-scheduler.sql` |
| Send execution | **Render** web service `lion-elite-os` (`srv-d97b8b6rnols73cl2hag`, free plan, auto-deploys `main`) | `POST /run/clinic-outreach` → `lib/outreach/clinic-outreach-run.js` |
| Qualification, suppression, 16 checks | Render, per send | `lib/outreach/clinic-qualification.js`, `lib/outreach-validation.js` |
| Provider | **Resend** (`lib/email-delivery.js`), sender `OUTREACH_FROM_EMAIL` | API key only on Render |
| Health | Render `GET /health/outreach` (public, no PII) | `routes/outreach-run.js` |
| Operator CRM UI | Base44 app **BuildPipeline.online** (`6abf2f9a1efb94c996802962`), workspace "Lion Elite Clinical" | Base44 entities (see §4) |
| Source and deploys | GitHub `lionelite/lion-elite-os`, `main` is protected (required `test` check) | |

Message lifecycle: discovered prospect → qualified (tier + 16 checks, evaluated
in the run) → `outreach_queue` row with a once-ever idempotency key
`sha256(prospect|campaign|step)` → `processing` (capacity reserved) → Resend
request carrying the same key → `sent` + `provider_message_id`, or `failed`
(definitive 4xx), or `uncertain` (timeout / 429 / 5xx / crash after acceptance).

## 2. Rules the code enforces

- **Day** = America/New_York calendar day, for `daily_usage` and every count.
  Before 2026-11-22 it was the UTC date, so the "daily" quota reset at 7 PM Eastern.
- **Cap**: the lower of `DAILY_SEND_CAP` (default 150) and `DAILY_EMAIL_LIMIT`
  (the store's quota). In-flight and uncertain messages reserve capacity, and
  an accepted message is always counted. Failed attempts do not consume it.
- **Window**: `OUTREACH_SEND_WINDOW` (default `09:00-15:00`, New York). It is
  enforced on the server, so no trigger can send outside it. A malformed value
  holds sending. Missed days are not caught up: the cap is per day.
- **Pacing**: each gap is the larger of the 30–90 s jitter and
  `0.9 × remaining window / remaining allowance`, capped at 10 minutes.
- **Uncertain submissions are never re-sent as new.** At the start of a live
  run, uncertain rows younger than 23 h are re-submitted with their stored key
  and identical stored content, after a fresh suppression and reply check.
  Resend returns the original result if it had accepted the message. Older
  rows, and rows that already hold a provider id, stay held for an operator.
- **Accepted but not recorded** (DB write fails after acceptance): the provider
  id is kept, the row is held as `uncertain`, and it is never marked `failed`.
- **Provider 429** stops the run.
- A live run evaluates only as many candidates as it can send in its time budget.
  Dry runs evaluate everything.

## 3. Configuration (Render service env; values are not in the repo)

| Variable | Meaning |
|---|---|
| `OUTREACH_SEND_ENABLED`, `RESEND_API_KEY`, `OUTREACH_FROM_EMAIL` | sending prerequisites (owner-controlled switch) |
| `OUTREACH_REPLY_TO`, `OUTREACH_UNSUBSCRIBE_EMAIL`, `OUTREACH_POSTAL_ADDRESS` | reply / opt-out / CAN-SPAM footer (postal default: 28396 Detroit Road, Westlake, OH 44145) |
| `DAILY_SEND_CAP` (150), `DAILY_EMAIL_LIMIT` | caps; the lower wins |
| `OUTREACH_SEND_WINDOW` (`09:00-15:00`) | New York sending window |
| `OUTREACH_RUN_BUDGET_MINUTES` | length of one run; ≈9 with the 10-minute scheduler |
| `OUTREACH_APPROVED_MESSAGE_VERSIONS` | owner-approved template versions |
| `OUTREACH_TEST_RECIPIENT` | where `?test=1` sends its single sample |
| `OUTREACH_SECRET` (optional) | manual `x-outreach-secret`; the scheduler uses its own Vault secret |

Scheduler secret: generated inside Supabase, held in Vault as
`clinic_outreach_scheduler_secret`. Only its SHA-256 is stored, in
`app_settings.scheduler_secret_sha256`.

## 4. Integration inventory (checked with a read-only request on 2026-11-22)

| System | Access from engineering session | State |
|---|---|---|
| GitHub (MCP) | read/write, Actions | connected |
| Render (MCP) | services, deploys, logs, env (write) | connected; env values are not readable |
| Supabase (MCP) | SQL | connected; pg_cron 1.6.4, pg_net 0.20.4, Vault installed |
| Base44 (MCP) | entity read/write; **file access blocked** (needs Base44 Builder plan) | connected, partial |
| Resend | no direct access (key exists only on Render) | evidence = provider ids returned on send; plan/quota **unverified** |
| Gmail / Calendar | Google connectors exist for the owner's account; not used by the production service | not integrated server-side |
| Calendly | booking link in the Base44 workspace record | not integrated |

**Second send path found:** the Base44 BuildPipeline.online agent "Pipeline
automation" sends through **Gmail** on its own. On 2026-11-20 at
15:12:33–15:13:40 UTC it sent 22 messages, about 2 s apart, with no provider ids.
They bypassed the canonical cap, pacing and targeting rules, and the
recipients included two gyms and a dental office. 11 of those recipients were
in Supabase with no contact record. They are now `held`, each with a
`prospect_events` row `outreach.sent_external`. Disabling or re-routing that
agent is an owner decision (see §7).

## 5. Incident runbook

| Symptom | Check | Action |
|---|---|---|
| `/health/outreach` `failing`, "scheduler has not ticked" | `SELECT * FROM cron.job_run_details d JOIN cron.job j USING (jobid) WHERE j.jobname='clinic-outreach-send' ORDER BY start_time DESC LIMIT 5;` | re-run `db/supabase/clinic-outreach-scheduler.sql` |
| ticks but no runs | `SELECT * FROM net._http_response ORDER BY created DESC LIMIT 5;` (status 401 = hash mismatch, timeout = Render asleep or down) | 401: re-run the SQL; otherwise check Render deploys/logs |
| runs, 0 sent | the run's `skipReasons` in `outreach_runs.summary` | "outside the sending window", cap 0, supply (`first touch: …`), provider 429 |
| `uncertainHeld` > 0 | `SELECT queue_id, recipient, last_error, updated_at, provider_message_id FROM outreach_queue WHERE status IN ('uncertain','processing');` | under 23 h it resolves on the next run; older ones need the Resend log to settle them, then set the status by hand |
| provider 429 | the run note `stopped: provider …` | plan/quota limit: raise the plan or lower `DAILY_SEND_CAP` |
| stop everything | `POST /api/cron/outreach-pause {"paused":true}` or `SELECT cron.unschedule('clinic-outreach-send');` | |

## 6. Deploy and rollback

Deploy: PR to `main` → required `test` check → merge → Render auto-deploys.
Verify with `mcp list_deploys` (status `live`, commit sha) and `/health/outreach`.
Rollback: revert the merge commit on `main`, or Render "rollback to deploy".
The scheduler is independent and can be stopped in seconds with
`cron.unschedule`. The GitHub sending workflows still dispatch manually.

## 7. Verification record

### Baseline (canonical `outreach_queue`, distinct idempotency keys, NY day)

| NY day | Accepted (provider id) | Failed | Uncertain | Base44/Gmail (outside pipeline) | `daily_usage` (old UTC key) |
|---|---|---|---|---|---|
| 2026-11-19 | 0 | 0 | 0 | 0 | 0 |
| 2026-11-20 | 25 | 0 | 0 | 22 (no provider ids) | 25 |
| 2026-11-21 | 13 | 0 | 0 | 0 | 3 |
| 2026-11-22 (to 23:15 UTC) | 7 | 0 | 0 | 0 | 17 |

"Accepted" means Resend returned a message id. **Delivery is unverified**: no
delivery/bounce events are ingested. The `daily_usage` mismatch on 11-21/11-22
is the UTC-day bug (both pairs sum to 20). The reported "24, 0, 0" matches the
old UTC-keyed counter for 11-14 (24), then 11-17 and 11-18 (no rows).

### Root causes of the shortfall

1. **Scheduler starvation.** GitHub fired the every-10-minutes send workflow 29
   times in 11 days, and only 1–3 of those per day fell inside the window.
2. **Re-qualifying every candidate on every run.** About 930 candidates took
   ~5.5 of an 8-minute run, so each run sent 2–6 (fixed in #199).
3. **Supply** before 2026-11-20 (discovery stored 0–1 a day). Fixed by the
   runner-side discovery job, which stores ~200+ a day.
4. **UTC-keyed daily counter** (accounting; the cap was not reached, so not
   the throughput cause).

### Open items (owner)

- **Resend plan.** The free plan allows 100/day and 3,000/month, which cannot
  carry 150/day. Confirm the plan in the Resend dashboard. The service now
  records Resend's rate-limit/quota response headers on each send (logged as `limits=`).
- **Base44 "Pipeline automation" Gmail sender.** Disable it, or route it through
  `POST /run/clinic-outreach`, so there is one sender. On the free Base44 plan
  this needs a Base44 builder turn (uses Base44 credits) or a plan upgrade.
- **Sending window.** The code enforces 09:00–15:00. #197 had moved GitHub's
  schedule to 09:00–23:00. Set `OUTREACH_SEND_WINDOW` if a wider window is
  approved.
- 11 more of the Base44 Gmail recipients are not in Supabase at all.

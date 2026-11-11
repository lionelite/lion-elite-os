# Daily clinic outreach over HTTP (free tier)

The Render account runs one free web service (`lion-elite-os`) on Supabase
Postgres. No Redis, workers or Render crons exist, so the BullMQ clinic pipeline
(`workers/outreach-worker.js` + the `lion-elite-clinic-outreach` cron in
`render.yaml`) never ran. This path does the same work in-process, triggered over
HTTP by a free GitHub Actions schedule. The BullMQ path is unchanged and still
works wherever Redis exists.

| Piece | File |
|---|---|
| Schedule (9:07 AM New York, weekdays) | `.github/workflows/daily-clinic-outreach.yml` |
| HTTP routes | `routes/clinic-outreach-cron.js`, mounted at `/api/cron` in `server.js` |
| The run | `lib/outreach/clinic-outreach-run.js` |
| Cap and schedule math | `lib/outreach/send-cap.js` |
| Pause switch, run ledger | `lib/outreach/outreach-control.js` (`app_settings`, `outreach_runs`) |
| Follow-up e-mail | `lib/outreach/clinic-followup-email.js` |
| Follow-up qualification | `lib/outreach/followup-qualification.js` |
| Never-email list | `lib/outreach/never-email.js` |
| Sheet mirror | `lib/outreach/sheets-mirror.js` |

## What one run does

Every route needs one of two credentials:

- `Authorization: Bearer <GitHub Actions OIDC token>`: what both workflows use.
  `lib/outreach/github-oidc.js` verifies the RS256 signature against GitHub's
  published keys. It accepts the token only if issuer, audience
  (`lion-elite-os-cron`), expiry, repository (`lionelite/lion-elite-os`), branch
  (`refs/heads/main`), event (`schedule`/`workflow_dispatch`) and workflow file
  (`daily-clinic-outreach.yml` or `outreach-control.yml`) all match. Tokens live
  about five minutes, and no long-lived secret exists to leak. The trust
  boundary is write access to the protected `main` branch, the same as for a
  repo secret.
- `x-cron-secret` equal to `CRON_SECRET`: optional, for manual `curl`. If it is
  unset, this path is unavailable.

Anything else gets 401. No configuration leaves the routes open.

`POST /api/cron/clinic-outreach` (`?dryRun=1` sends nothing):

1. **Gates.** If outreach is paused, the run is recorded as `paused` and stops.
   Real sends run only on weekdays in New York, and only once per New York day:
   a second call after a completed run returns `skipped`. A Postgres advisory
   lock stops two runs overlapping. If sending is not configured
   (`OUTREACH_SEND_ENABLED`, `RESEND_API_KEY`, `OUTREACH_FROM_EMAIL`,
   `OUTREACH_POSTAL_ADDRESS`), the run is forced to a dry run and says so in
   `notes`.
2. **Discovery.** One metro per run, rotating through the 31 areas in
   `lib/discovery/discovery-run.js`. It searches OpenStreetMap (Overpass) for the
   med-spa and clinic categories, then reads each clinic's own website for the
   contact e-mail the clinic publishes. Both sources are free, and no paid API
   is used (the summary's `discovery.source` says so). The repo has no paid
   discovery agent, so no fallback was needed. Before enrichment, a business is
   skipped if its website domain is already in `prospects`, or if
   `lib/contacts/clinic-targeting.js` rates it `low`/`exclude`. Peptide, HRT/TRT,
   weight-loss, longevity, regenerative and aesthetic practices rate high.
   Before insert, an e-mail address or e-mail domain already in `prospects` is a
   duplicate. New rows are stored as stage `discovered`, campaign
   `osm-business-discovery`, with `enrichment.source`.
3. **Qualification.**
   - *First touch*: `discovered`/`qualified` rows in
     `osm-business-discovery`/`med_spa_research_supply` with an e-mail go through
     `qualifyClinicProspect` and then the unchanged 16-check engine. A domain
     that any other record has already reached (stage `contacted`, `replied`,
     etc.) counts as a duplicate, because the October sends happened outside
     `outreach_queue`.
   - *Follow-up*: `contacted` rows go through `qualifyFollowUp` and the same 16
     checks. They are skipped for stage `suppressed`/`replied`/`disqualified`,
     status `held`/`suppressed`, a `do_not_contact`/`suppressed` flag on the
     record, the opt-out list, the never-email list, a personal mailbox, an inbox
     domain that does not match the clinic's site, or an inbox domain with no MX
     records (checked live: an import date is not evidence that an address still
     works). A clinic also waits if it was e-mailed within 14 days, or if it got 3
     sends in the last 30 days: 16 of the October clinics got three sends after
     Oct 11, so they become eligible as their window clears, around Nov 24. Each
     clinic gets one automated follow-up at most.
4. **Send.** One shared cap. First touches go first, then follow-ups, with at
   most one per organisation per run, and 30–90 s between sends. Immediately
   before each send, the run re-checks the pause switch and re-reads the prospect
   for a reply or opt-out: a replied/engaged stage, a suppressed/held status, the
   opt-out list, a recorded `prospect.replied`/`prospect.opted_out` event, or a
   queue item marked `replied`. If it finds one, it sets the stage to `replied`
   or `suppressed` and skips the send. Every send goes through
   `outreach_queue` (`store.enqueue`/`markQueue`), so the `DAILY_EMAIL_LIMIT`
   quota, the suppression re-check and the audit events all apply. The queue's
   idempotency key is `sha256(prospect | campaign | step)`, and Resend receives
   the same key, so a given clinic gets a given step once no matter how often the
   run repeats. After a send, the stage becomes `contacted` (the live table's
   vocabulary) and `enrichment.last_sent` is updated.
5. **Record and mirror.** The run writes an `outreach_runs` row (counts,
   `skip_reasons`, full summary) and returns the summary as JSON. Every prospect
   created or changed during the run is then appended to the sheet's `Pipeline`
   tab. A header row is written if the tab is empty. A mirror failure is reported
   and does not fail the run.

The run can take over an hour. The HTTP response is committed as 200
immediately, and a space is written every 20 s so no proxy drops the connection.
Read `status` in the JSON body (`completed`/`paused`/`skipped`/`error`), not the
HTTP code. The workflow does exactly that. A run stops sending after
`OUTREACH_RUN_BUDGET_MINUTES` (default 100, inside the workflow's 115-minute
curl limit). Anything left over is eligible on the next run.

Other routes (also available from **Actions → Outreach control**):

- `GET /api/cron/clinic-outreach/status`: pause state, today's ramp, last 10 runs.
- `POST /api/cron/outreach-pause` `{"paused": true|false, "reason": "..."}`.
- `POST /api/cron/outreach-reply` `{"email": "...", "type": "reply"|"opt_out"}`.
  `reply` sets every record with that address to `replied`. `opt_out` also adds
  the address to `outreach_suppressions`.

## Daily cap

```
cap = min(DAILY_SEND_MAX (150), 20 + 10 × full weeks since OUTREACH_START_DATE)
effective = min(cap, DAILY_EMAIL_LIMIT − sent today)
```

Before `OUTREACH_START_DATE` the cap is 0. If the start date is unset or invalid,
the cap stays at 20. `DAILY_EMAIL_LIMIT` (default 100) is the store's own
transactional quota and is not relaxed here. Set it to 150 if the ramp should
reach 150.

## Pause switch

The Redis kill switch cannot be reached on the free tier. For this path it is
replaced by `app_settings.outreach_paused` in Postgres. Like the Redis switch, it
fails closed: if the setting cannot be read, the run treats outreach as paused.
If `REDIS_URL` is ever configured, the Redis switch is honoured as well.

## Never-email list

`info@thelevelt.com`, the whole `thelevelt.com` domain (Level T replied and a
person owns that thread), and `asim.hasnie@intechaero.com`. The list lives in
code so a mistyped env var cannot remove an entry. `OUTREACH_NEVER_EMAIL` can
only add to it. The list is checked when the run picks recipients and again
right before each send.

## What this does not do

- **No automatic inbox reading.** Nothing reads the reply-to inbox, so a reply
  only stops the sequence once it is recorded: stage `replied` in Supabase, or
  `POST /api/cron/outreach-reply`. Wiring that endpoint to an inbox
  (a Gmail filter plus a script, or Resend inbound) is the next step if wanted.
- **No sends without the owner's switches.** `OUTREACH_SEND_ENABLED` and the
  message-version approvals are owner actions.
- **Dry runs still discover and record qualification.** They write discovery
  rows and the qualification evidence on each prospect. They never queue or send.

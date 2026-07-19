# Bluesky automated outreach

The social listener can now automatically reply to qualified public Bluesky opportunities through the Bluesky API. A webhook delivery mode is also available as a fallback.

## Run

- One pass: `npm run listen:outreach`
- Continuous worker: `npm run listen:outreach-worker`

## Environment variables

- `BLUESKY_OUTREACH_ENABLED=true` — master kill switch. Defaults to disabled.
- `BLUESKY_OUTREACH_DRY_RUN=false` — required for real delivery. Defaults to dry run.
- `BLUESKY_OUTREACH_DELIVERY_MODE=direct` — sends replies directly through Bluesky. Use `webhook` for the legacy handoff mode.
- `BLUESKY_HANDLE` — Bluesky account handle used for outreach.
- `BLUESKY_APP_PASSWORD` — Bluesky app password. Store only in Render/local environment variables, never GitHub.
- `BLUESKY_SERVICE_URL=https://bsky.social` — optional override for the AT Protocol service.
- `BLUESKY_OUTREACH_MIN_SCORE=60` — minimum listener score.
- `BLUESKY_OUTREACH_MAX_PER_RUN=5` — cap per worker cycle.
- `BLUESKY_OUTREACH_MAX_PER_DAY=25` — daily cap.
- `BLUESKY_OUTREACH_INTERVAL_MS=300000` — worker interval; minimum 60 seconds.
- `BLUESKY_OUTREACH_AUDIENCES=business-scaling,personal-training` — allowed lanes.
- `OUTREACH_WEBHOOK_URL` — required only when delivery mode is `webhook`.
- `OUTREACH_WEBHOOK_TOKEN` — optional bearer token for webhook mode.

The engine always excludes matches marked `doNotEngage`, deduplicates by Bluesky DID/post/audience, logs every delivery attempt, applies per-run and per-day caps, and stops immediately when `BLUESKY_OUTREACH_ENABLED` is not `true`.

Direct mode creates a public reply to the matched Bluesky post. It fetches the original post record, preserves the correct thread root, authenticates using an app password, and creates the reply through the AT Protocol API.

No platform credentials belong in GitHub. Store all secrets in Render environment variables or your local shell environment.

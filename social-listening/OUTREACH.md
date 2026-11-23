# Bluesky automated outreach

The social listener can now hand qualified public Bluesky opportunities to an authenticated LionOS delivery service automatically.

## Run

- One pass: `npm run listen:outreach`
- Continuous worker: `npm run listen:outreach-worker`

## Environment variables

- `BLUESKY_OUTREACH_ENABLED=true` — master kill switch. Defaults to disabled.
- `BLUESKY_OUTREACH_DRY_RUN=false` — required for real delivery. Defaults to dry run.
- `BLUESKY_OUTREACH_MIN_SCORE=60` — minimum listener score.
- `BLUESKY_OUTREACH_MAX_PER_RUN=5` — cap per worker cycle.
- `BLUESKY_OUTREACH_MAX_PER_DAY=25` — daily cap.
- `BLUESKY_OUTREACH_INTERVAL_MS=300000` — worker interval; minimum 60 seconds.
- `BLUESKY_OUTREACH_AUDIENCES=business-scaling,personal-training` — allowed lanes.
- `BLUESKY_BOT_DID` — DID of the Lion Elite bot/account. Required whenever outreach is enabled; only posts whose structured facets explicitly mention this DID are eligible.
- `OUTREACH_WEBHOOK_URL` — authenticated delivery endpoint for the outbound social adapter.
- `OUTREACH_WEBHOOK_TOKEN` — optional bearer token for that endpoint.

The engine only replies when the post's structured Bluesky mention facet explicitly tags `BLUESKY_BOT_DID`. It also excludes matches marked `doNotEngage`, deduplicates by Bluesky DID/post/audience, logs every delivery attempt, and stops immediately when `BLUESKY_OUTREACH_ENABLED` is not `true`. This keeps automated interactions opt-in under Bluesky's bot guidance; ordinary public keyword matches remain read-only leads.

No platform credentials belong in GitHub. Store all secrets in Render environment variables.

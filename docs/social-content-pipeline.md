# Daily Social Content Pipeline (Issue #48, Phase 1)

Automated daily content generation for **Lion Elite Wellness** and **Lion
Elite Beauty** across Instagram, Facebook, TikTok, LinkedIn, and X — the
free workflow: content is generated and validated automatically, then
scheduled through Metricool's CSV batch import (Metricool API access
requires an Advanced/Custom plan, so Phase 1 deliberately avoids it).

## How it works

`.github/workflows/daily-social-content.yml` runs every day at **7:00 AM
America/New_York** (two UTC crons + a timezone guard handle DST) and calls:

```bash
node scripts/generate-social-content.js [--date=YYYY-MM-DD] [--dry-run] [--no-ai]
# or: npm run social:generate
```

Per brand, per day it generates the Issue #48 cadence:

- 1 feed post (educational for Wellness, transformation/coaching for Beauty)
- 1 Reel/TikTok script
- 2 Stories (feed-topic teaser + engagement question)

Each piece gets platform-specific caption variants (Instagram, Facebook,
LinkedIn, X ≤ 280 chars, TikTok script) plus a media spec: **1080x1350**
(4:5) for feed images, **1080x1920** (9:16) for Stories/Reels, with an
image-generation prompt in the brand aesthetic.

### Module map

| File | Purpose |
|---|---|
| `lib/social/brand-profiles.js` | Brand voice, topic pools (16/brand), CTA rotations, hashtags, wellness disclaimer |
| `lib/social/content-generator.js` | Deterministic template generation of the daily cadence |
| `lib/social/social-compliance.js` | Fail-closed compliance validation (see below) |
| `lib/social/topic-rotation.js` | Duplicate-topic detection + seven-day rotation |
| `lib/social/metricool-csv.js` | Metricool-compatible CSV builder |
| `lib/social/ai-provider.js` | Optional AI caption enhancement (template fallback) |
| `scripts/generate-social-content.js` | Orchestrator CLI |

### Compliance rules (fail-closed)

Lion Elite Wellness is **research-use-only** (see
`docs/customer-communication-rules.md`). The validator blocks: dosing
language (including any mg/mcg/IU amounts), human-use instructions,
treatment/disease/diagnosis claims, transformation promises, guarantees,
and hype language — and requires the disclaimer *"For laboratory research
purposes only. Not for human or veterinary use."* on every piece.

Lion Elite Beauty allows transformation/coaching language but blocks
medical claims, guarantees, specific outcome promises ("lose 20 lbs"), and
any research-compound language (brand separation).

A blocked AI rewrite silently falls back to the pre-validated template. A
blocked template piece is excluded from the CSV, logged in
`generation-log.json`, and reported — the workflow then **opens a GitHub
issue automatically** (label `social-content`), same as when the run
itself fails.

### Duplicate detection and rotation

Topics rotate through a 16-topic pool per brand; a topic used by a brand in
the previous 7 days is never selected again (the pool cycle is 8 days, so
the window never exhausts; if history ever forces it, selection degrades to
least-recently-used instead of failing). History is read from previously
committed runs under `content/generated/`.

### Output layout

Outputs are committed to the unprotected **`automation/social-content`**
branch (`main` requires the `test` status check, which a content-only bot
push can never satisfy — same pattern as `manual-daily-agent.yml`):

```
content/
  generated/YYYY-MM-DD/
    social-content.json    # structured posts, per-platform text, compliance results
    metricool-YYYY-MM-DD.csv
    media-prompts.md       # image specs + prompts (1080x1350 / 1080x1920)
    generation-log.json    # generated / rejected / scheduled / published counts + blocks
  metricool-import/
    week-of-YYYY-MM-DD.csv # Mon–Sun combined CSV, refreshed daily
```

### Public media hosting

The public repo doubles as the media host: image files committed under
`content/media/YYYY-MM-DD/<piece-id>.jpg` on the `automation/social-content`
branch are served as stable HTTPS URLs via `raw.githubusercontent.com`, and
those URLs are written into the Metricool CSV's `Picture Url 1` column
automatically (all platform rows of a piece share its image).

Image sources, in priority order:

1. **Human-dropped** — put a finished **JPEG** at
   `content/media/<date>/<piece-id>.jpg` on the automation branch (piece
   ids are printed in the run log and in `social-content.json`). Always
   wins over generation. JPEG specifically: Instagram's publishing API
   rejects PNG.
2. **AI-generated (opt-in)** — set the repo *variable* `AI_IMAGE_ENABLED=true`
   (with the existing `AI_API_KEY`/`OPENAI_API_KEY` secret) and the daily
   run generates portrait images (gpt-image-1, 1024x1536) from each
   feed/reel piece's media prompt. Off by default because every image is a
   paid API call (~6/day when on). `AI_IMAGE_MODEL` overrides the model.
3. **Neither** — the CSV row has an empty `Picture Url 1`, exactly as
   before. Note Instagram/TikTok require media, so imageless rows for
   those networks still need an image attached inside Metricool.

`MEDIA_BASE_URL` (repo variable) swaps `raw.githubusercontent.com` for any
future CDN or site host without touching code; `MEDIA_BRANCH` overrides the
branch. URLs become live when the workflow's commit lands on the automation
branch — which always happens before a human downloads the CSV, so
Metricool can fetch them at import time.

## Importing into Metricool

1. Open the weekly file under `content/metricool-import/` on the
   `automation/social-content` branch.
2. In Metricool: Planner → CSV import → upload the file. Choose date format
   `YYYY-MM-DD` and 24-hour time when prompted.
3. Each row targets exactly one network (captions are platform-specific);
   `Draft` is `FALSE`, so rows land as scheduled posts at their local times.
4. Stories are **not** in the CSV (CSV import would publish them as feed
   posts). Post them manually from `social-content.json` +
   `media-prompts.md`.

The column header lives in one constant (`HEADER` in
`lib/social/metricool-csv.js`). If Metricool revises its template, download
the current sample from their planner and adjust that constant — nothing
else needs to change.

## Configuration and secrets

All tokens are **repository/environment secrets only — never commit
tokens** (see the hard limits in `CLAUDE.md`).

| Secret / var | Used for | Required? |
|---|---|---|
| `AI_API_KEY` (secret) | AI caption enhancement (OpenAI-compatible) | No — falls back to `OPENAI_API_KEY`, then to template mode |
| `OPENAI_API_KEY` (secret) | Fallback AI key (already used by other workflows) | No |
| `AI_MODEL` / `OPENAI_MODEL` (variable) | Model override (default `gpt-4o-mini`) | No |
| `META_ACCESS_TOKEN`, `META_PAGE_ID`, `INSTAGRAM_BUSINESS_ACCOUNT_ID` | **Phase 2 only** (direct publishing) — not read by any Phase 1 code | No |

The pipeline is fully functional with **zero secrets configured**: it runs
in deterministic template mode, which is also what every CI test exercises.

### Token rotation

1. Generate the replacement key with the provider (OpenAI dashboard for
   `AI_API_KEY`/`OPENAI_API_KEY`; Meta Business Suite for Phase 2 tokens).
2. Update the value in GitHub → Settings → Secrets and variables → Actions.
3. Revoke the old key at the provider.
4. Trigger the workflow manually (Actions → Daily Social Content → Run
   workflow) and confirm the log line `AI enhancement: enabled`.
5. Never paste a token into an issue, commit, log, or `render.yaml`. If a
   token leaks, revoke it first, then rotate.

## Phase 2 (not built)

Direct publishing via Meta Graph API / TikTok Content Posting API /
LinkedIn Posts API / X API, or the Metricool API on an upgraded plan, is
Issue #48 Phase 2 and intentionally out of scope here. Nothing in Phase 1
sends anything to any platform — output is files only, and scheduling stays
a human action (uploading the CSV), consistent with the "no customer-facing
outreach as an automation side effect" hard limit.

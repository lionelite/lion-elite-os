# Auto-Publishing (Issue #48 Phase 2)

Automatically posts the day's **own-brand** generated content to **our own**
Lion Elite Wellness / Lion Elite Beauty accounts. This is a scheduler
publishing our content to our profiles — it is **not** the engagement bot
that was declined: no replies, no DMs, no likes, no follows, nothing
directed at other people's posts. The read-only `social-listening/` monitor
is completely separate and unchanged.

## What publishes, where

Runs as a step in `.github/workflows/daily-social-content.yml`, **after**
generation and the content commit (so hosted image URLs are already live).
Only the **feed** piece per brand auto-publishes:

| Platform | Status | Notes |
|---|---|---|
| Instagram Business | live | Meta Graph API; requires the hosted image URL (media-hosting layer) |
| Facebook Page | live | Meta Graph API; photo post if image present, else text |
| X | live | v2 API, OAuth 1.0a user context (free-tier posting) |
| Bluesky | live | app password; reuses the ≤280-char X caption |
| TikTok / LinkedIn | **not built** | require app-approval processes (weeks); clean seams left in `lib/social/publishers/` |

Reels, TikTok scripts, and Stories are **not** auto-published — they need
video assets / story APIs we don't generate. They stay in the JSON + the
Metricool CSV for manual posting.

## Safety model

- **Fail-closed master switch:** nothing publishes unless the repo variable
  `SOCIAL_PUBLISH_ENABLED=true`. Unset/false = generate + CSV only, exactly
  as today.
- **Missing credentials = skip, not error:** a platform without its secrets
  is simply not a target. Enable platforms one at a time by adding secrets.
- **Compliance-gated content only:** the publisher reads
  `social-content.json`, which contains only pieces that passed the
  fail-closed compliance validator. Rejected content never reaches it.
- **Idempotent:** each success is recorded in
  `content/generated/<date>/publish-log.json` (committed to the automation
  branch). A workflow rerun re-reads the log and skips anything already
  published — no double-posting. Failed attempts are retried.
- **Isolated failures:** one platform failing (bad token, rate limit)
  records a failed result and continues; it never blocks the others.
- **Kill switch:** set `SOCIAL_PUBLISH_ENABLED=false` (repo variable) to
  stop all publishing on the next run. For an immediate stop mid-day,
  disable the workflow in the Actions tab.

## Setup

All values are **repository secrets** (Settings → Secrets and variables →
Actions → Secrets), except the enable flag which is a **variable**. Per
brand, prefix `WELLNESS_` or `BEAUTY_`. Add only the platforms you want;
the rest stay dormant.

**Enable flag (variable):** `SOCIAL_PUBLISH_ENABLED = true`

**Instagram + Facebook (Meta):**
1. Create a Meta app, add the Facebook Login and Instagram Graph products.
2. Connect the brand's Facebook Page and its linked Instagram **Business**
   account.
3. Generate a **long-lived Page access token** with `pages_manage_posts`,
   `instagram_basic`, `instagram_content_publish`.
4. Secrets: `<BRAND>_META_ACCESS_TOKEN`, `<BRAND>_META_PAGE_ID`,
   `<BRAND>_IG_USER_ID` (the IG Business account id).
   - Long-lived Page tokens still expire (~60 days) — rotate them; a
     failed publish with an auth error is the signal.

**X:** create a project/app in the X developer portal with **Read and
Write**, generate API key/secret + access token/secret (user context).
Secrets: `<BRAND>_X_API_KEY`, `<BRAND>_X_API_SECRET`,
`<BRAND>_X_ACCESS_TOKEN`, `<BRAND>_X_ACCESS_SECRET`. (Free tier ≈ enough for
the one feed post/day.)

**Bluesky:** in the brand account's Settings → App Passwords, create one.
Secrets: `<BRAND>_BSKY_IDENTIFIER` (handle, e.g. `lionelitewellness.bsky.social`),
`<BRAND>_BSKY_APP_PASSWORD`. Use an **app password**, never the main one.

## Go-live sequence

1. Add secrets for **one** platform on **one** brand (Bluesky is the
   easiest first — no approval process).
2. Leave `SOCIAL_PUBLISH_ENABLED` unset; run the workflow manually with a
   date and confirm the **dry-run**-style log shows the target resolved.
3. Set `SOCIAL_PUBLISH_ENABLED=true`; run manually again; confirm the post
   appears on the account and `publish-log.json` records it.
4. Add platforms/brands incrementally, watching the first real post on each.

## Local use

```bash
npm run social:publish -- --date=2026-07-20 --dry-run   # show resolved targets
npm run social:publish -- --date=2026-07-20             # publish (needs env + enable flag)
```

## Peptide Info Series (per-product daily images)

`lib/social/peptide-catalog.js` + `scripts/generate-peptide-images.js`
produce one research-education product spotlight per day for the Wellness
lane — a labeled research-vial image plus a compliance-passing caption for
each approved peptide.

```bash
npm run social:peptide-images -- --start=2026-07-19 --list          # 18-day plan, no API
npm run social:peptide-images -- --start=2026-07-19 --all           # backfill all 18 (needs AI image key)
npm run social:peptide-images -- --start=2026-07-19 --date=2026-07-25  # just that day
```

Images write to `content/media/<date>/<date>-wellness-feed.jpg` — the exact
path the media-hosting and auto-publish layers already read — so a
generated peptide image becomes that day's Instagram/Facebook image
automatically. Rendering requires `AI_IMAGE_ENABLED=true` + an image key;
without it the script still writes every prompt + caption to
`content/generated/<date>/peptide-series.json` so a designer can render or
drop JPEGs at the listed paths.

**Two compliance guardrails are baked into the data:**

1. **Approved products only.** The catalog contains only peptides on
   `lion-elite-wellness/product-master-list.md`. **Testosterone Cypionate**
   (a Schedule III controlled substance), **Melanotan II**, and **PT-141**
   from the source calendar are deliberately excluded and listed in
   `EXCLUDED_PRODUCTS` — do not add them without an owner decision.
2. **Research-education captions only.** Every caption describes the
   research area a compound is studied in, never an effect in a person, and
   carries the RUO disclaimer. `test/social-peptide-catalog.test.js` runs
   each caption through the fail-closed compliance validator, so a caption
   that drifts into human-use/dosing/transformation language fails CI
   before it can publish. This is why the original calendar's themes ("Fat
   Loss & Metabolic Support", "Muscle Growth & Recovery", "Skin
   Regeneration & Anti-Aging", etc.) are **not** used verbatim — they are
   human-use claims the validator blocks.

## Compliance note

Lion Elite Wellness content published here is the same research-education
copy the compliance validator already gates (no dosing, human-use,
treatment, or transformation claims; research disclaimer present). Auto-
publishing does not change what is said — only that it posts on schedule.

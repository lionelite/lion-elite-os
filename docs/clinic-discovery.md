# Clinic discovery

Finds new clinics that publish a business e-mail address and stores them as
`lion-elite-clinical` prospects in Supabase. It is a separate job from sending:
`.github/workflows/clinic-discovery.yml` finds clinics, and
`.github/workflows/clinic-outreach.yml` qualifies and e-mails them.

Free sources only: OpenStreetMap (Overpass) and each clinic's own website.

## Why it was rebuilt (2026-11-20)

The pool of about 150 clinic prospects had all been contacted, and discovery was
adding 0–1 a day:

- **Nominatim answered every bulk search with 429.** It is a geocoder with a
  1 request/second policy, not a bulk search API. It has been removed from bulk
  search (`lib/discovery/nominatim-source.js` is deleted).
- **Overpass timed out.** It was queried once per category per metro with a
  45-second budget, from Render's shared IPs, which overpass-api.de refuses.
- **Discovery ran inside the send job**, a few metros per run, so map searches,
  website crawls and spaced sends all competed for one time budget.
- **The Bluesky universal-lead and audience scanners** stored 2,227 prospects
  and none had an e-mail address. They are now off (see below).

## How it works

Every two hours (`41 */2 * * *` UTC), on the GitHub runner,
`scripts/discover-clinics.js` does the following:

1. `POST /run/clinic-discovery/state` returns how many clinics have been stored
   today (New York day), the target (200), the metro cursor and the 50 metros.
2. It works through each metro, starting at the cursor, and stops when the day's
   target is reached, after the last metro, or when the 100-minute budget runs
   out:
   1. **One Overpass query per metro bounding box**
      (`lib/discovery/clinic-overpass.js`). The server budget is
      `[timeout:90]`. The starting mirror rotates per metro (overpass-api.de,
      overpass.kumi.systems, overpass.private.coffee). After a failure it retries
      on the next mirror with backoff of 5, 10, 20 and 40 seconds (capped at 60),
      up to 6 attempts, and honours `Retry-After`. The query matches
      `amenity=clinic|doctors`, `healthcare=*`, `beauty=spa`, and
      `shop=beauty`/`leisure=spa` listings whose name says med spa, aesthetic,
      IV, hormone, wellness, weight loss or longevity. Every listing must have a
      `website` or `contact:website` tag.
   2. **Excluded trades are dropped:** pharmacies, hospitals, dentists,
      paediatrics, fertility and similar. Listings that
      `lib/contacts/clinic-targeting.js` rates `low` or `exclude` are dropped
      too. High-tier clinics are crawled first.
   3. **`POST /run/clinic-discovery/known`** skips any site already on record,
      matched by website or e-mail domain under any campaign. It also skips any
      site crawled in the last 30 days that had no business e-mail.
   4. **The crawl** (`lib/discovery/clinic-site-crawl.js`) reads the home page,
      then the contact, about and team pages: linked ones first, otherwise
      `/contact`, `/contact-us`, `/about`, `/about-us`, `/team` and `/our-team`.
      It reads at most 5 pages per site, one at a time, and crawls 10 sites in
      parallel. It records:
      - **Business e-mail.** It must be on the clinic's own domain. Webmail
        (gmail, yahoo, hotmail and others) is refused and counted, and so is a
        `first.last@` mailbox. Role inboxes (`info@`, `frontdesk@`,
        `appointments@` and similar) are preferred. Cloudflare-obfuscated
        addresses are decoded.
      - **Business phone.** `tel:` links are used first, then the page text,
        then the OSM tag.
      - **Owner, founder or medical director name**, with the page it was found
        on. It is stored in `business.leadership` and `enrichment.leadership`.
        It is not used as a recipient, and it is not used in e-mail copy.
      - **Service signals** (hormone, weight loss, IV, aesthetics and others).
        These are recorded as evidence only.
   5. **`POST /run/clinic-discovery/store`**: the Render service checks the
      domains again, refuses webmail, off-domain addresses, the never-email list
      and low-tier clinics, and stores the rest through
      `PostgresProspectStore.create`, which dedupes by fingerprint. Sites with
      no e-mail go into `discovery_site_checks`. The metro cursor then advances.
3. `POST /run/clinic-discovery/log` writes one row to `clinic_discovery_runs`
   with the run totals: queried, found, with website, with email and stored. It
   also writes per-metro rows to the job summary.

The runner holds no database credential. It authenticates to the service with
`OUTREACH_SECRET`, or with a GitHub OIDC token issued to `clinic-discovery.yml`
on `main`, fetched again for every call.

## What gets sent

Nothing is sent by this job. Each hour, `clinic-outreach.yml` picks up
`lion-elite-clinical` prospects in `discovered` and runs them through
`lib/outreach/clinic-qualification.js` and the 16-check engine without changes.
One of those checks matters here: **only clinics that clinic-targeting rates
`high` are sent to unattended.** Medium-tier clinics are stored but need a
person to check them first. That gate was not changed. To see the split:

```sql
SELECT enrichment->>'targetingTier' AS tier, count(*)
FROM prospects WHERE campaign_id = 'lion-elite-clinical' AND stage = 'discovered'
GROUP BY 1;
```

## Knobs

| Where | Variable | Default |
|---|---|---|
| Render service | `CLINIC_DISCOVERY_DAILY_TARGET` | 200 stored per New York day |
| Workflow env | `DISCOVERY_BUDGET_MINUTES` | 100 |
| Workflow env | `DISCOVERY_MAX_CRAWLS_PER_METRO` | 150 |
| Workflow env | `DISCOVERY_CRAWL_CONCURRENCY` | 10 |
| Manual dispatch | `max_metros` | all 50 |
| Render service | `CLINIC_SEND_RUN_DISCOVERY=true` | off. Restores the old in-process search in the send run. |

## Reading the numbers

```sql
SELECT run_date, started_at, queried, found, with_website, with_email, stored,
       summary->'totals'->>'stopReason' AS stop
FROM clinic_discovery_runs ORDER BY started_at DESC LIMIT 20;
```

`found` counts named listings returned by Overpass. `with_website` counts those
with a usable site. `with_email` counts sites where a business e-mail was found.
`stored` counts clinics that were new. A metro whose query failed shows its
error in the per-metro table and in `summary->'metros'`. A run where every query
failed exits non-zero, so the failure is visible and is not reported as zero
clinics found.

## Ceiling

OpenStreetMap holds a finite number of clinics with websites in these 50 metros.
Once every metro has been crawled, later passes mostly return `already known`.
A site with no e-mail is checked again after 30 days. Growth beyond that needs
more metros or another free directory source.

## Bluesky scanners

`start.js` no longer starts the Bluesky listener. `monitor.js` no longer writes
universal-lead or audience matches to `prospects` unless
`BLUESKY_LEAD_STORAGE_ENABLED=true`. The 2,227 existing rows have not been
deleted. `lead-harvest.yml` now runs only on manual dispatch, because its OSM
pass competed with this job for Overpass.

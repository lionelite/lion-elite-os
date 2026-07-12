# Render Cron Automation

Lion Elite OS uses Render Cron Jobs to publish recurring work into Redis/BullMQ. Cron processes remain short-lived; background workers perform the durable work with retries, locks, and dead-letter routing.

## Schedules

| Service | UTC schedule | Purpose |
|---|---:|---|
| `lion-elite-business-discovery` | Every 4 hours | Queue approved-source business discovery batches |
| `lion-elite-stale-data-refresh` | Every 6 hours at :15 | Refresh prospect data older than the configured freshness window |
| `lion-elite-followup-scheduler` | Hourly | Find due follow-ups and route them through suppression and validation checks |
| `lion-elite-daily-analytics` | Daily at 12:00 UTC | Generate the previous 24-hour executive analytics job |
| `lion-elite-weekly-maintenance` | Sundays at 07:00 UTC | Queue retention, cleanup, and maintenance work |

## Reliability

- Cron services publish jobs; they do not perform long-running scraping or sending.
- Stable period-based job IDs prevent duplicate runs for the same schedule window.
- BullMQ provides retries and exponential backoff.
- Failed jobs ultimately route to the dead-letter queue.
- External outreach still requires authorization, suppression checks, idempotency, and daily quota enforcement.

## Manual execution

```bash
node scripts/cron-scheduler.js discovery
node scripts/cron-scheduler.js staleData
node scripts/cron-scheduler.js followups
node scripts/cron-scheduler.js analytics
node scripts/cron-scheduler.js cleanup
```

`REDIS_URL` is required. `DATABASE_URL` is available to cron jobs for future direct reporting queries, but scheduling currently publishes through Redis.

# Render Redis and Worker Architecture

Lion Elite OS uses Render Key Value (Redis-compatible) storage with BullMQ for background processing.

## Services

- `lion-elite-outreach-api`: accepts workflow requests and publishes jobs.
- `lion-elite-outreach-worker`: consumes email-generation, validation, and dispatch-preparation jobs.
- `lion-elite-os-redis`: queue, lock, cache, retry, and dead-letter infrastructure.
- `lion-elite-os-db`: durable system of record.

## Workflow

1. `POST /api/workflows/outreach` publishes an email-generation job.
2. Email worker generates and scores the personalized draft.
3. Approved drafts move to the validation queue.
4. Validated prospects receive an authorization and move to dispatch.
5. Dispatch currently stops at `authorized_for_delivery`; a provider adapter must perform the external send.
6. Exhausted jobs move to the dead-letter queue.

## API

### Start an outreach workflow

`POST /api/workflows/outreach`

The request must include `prospect` and may include campaign, offer, verified facts, goals, and policy overrides.

### Add a job manually

`POST /api/jobs/:queue`

Supported queue keys: `discovery`, `research`, `enrichment`, `qualification`, `personalization`, `email`, `validation`, `dispatch`, and `analytics`.

### Queue metrics

`GET /api/metrics/queues`

Returns waiting, active, completed, failed, delayed, and paused counts for every queue.

## Reliability

- Four attempts by default.
- Exponential retry backoff starting at five seconds.
- Distributed lock per queue job.
- Dead-letter queue after final failure.
- Stable job IDs prevent duplicate workflow publication.
- Completed jobs are retained for one day or up to 1,000 records.

## Render environment variables

- `REDIS_URL`
- `WORKER_CONCURRENCY=5`
- `JOB_ATTEMPTS=4`
- `JOB_BACKOFF_MS=5000`
- `JOB_LOCK_TTL_MS=120000`

PostgreSQL remains the durable system of record. Redis is used only for transient execution state, caching, locks, and queue coordination.

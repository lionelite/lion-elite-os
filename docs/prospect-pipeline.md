# Prospect Pipeline and Outreach Queue

Lion Elite OS now persists prospect lifecycle records, queue items, and audit events in an atomic JSON store. Set `PROSPECT_STORE_PATH` to place the data file on persistent storage in production.

## Prospect endpoints

- `POST /api/prospects` — create a prospect; deterministic fingerprints prevent duplicates.
- `GET /api/prospects` — filter by `stage`, `campaignId`, `ownerId`, or `status`.
- `GET /api/prospects/:id` — return the prospect and complete audit timeline.
- `PATCH /api/prospects/:id` — update mutable prospect fields.
- `POST /api/prospects/:id/transition` — move the prospect to an approved lifecycle stage.

## Queue endpoints

- `POST /api/prospects/:id/queue` — queue an authorized message.
- `GET /api/outreach/queue` — filter queue items by status, campaign, or prospect.
- `PATCH /api/outreach/queue/:id` — mark processing, sent, failed, replied, meeting booked, or suppressed.
- `GET /api/metrics/pipeline` — return prospect-stage and queue-status totals.

## Required queue authorization

A queue request must include a successful result from `/api/outreach/authorize`:

```json
{
  "authorization": {
    "authorized": true,
    "validationRunId": "val_123",
    "idempotencyKey": "unique-send-key"
  },
  "message": {
    "channel": "email",
    "recipient": "info@example.com",
    "subject": "Partnership idea",
    "body": "...",
    "messageVersion": "campaign-v1"
  }
}
```

Missing authorization fails closed. Reusing an idempotency key returns the existing queue item instead of creating another send.

## Production note

The atomic JSON store is suitable for the current single-instance MVP. Before horizontally scaling the worker, replace it with PostgreSQL while preserving the `ProspectStore` interface and enforcing database-level unique constraints on business fingerprints and message idempotency keys.

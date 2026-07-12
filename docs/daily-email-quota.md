# Daily Email Quota

Lion Elite OS enforces a hard default limit of **100 successfully sent emails per UTC day**.

## Configuration

Set `DAILY_EMAIL_LIMIT` to override the default. Example:

```bash
DAILY_EMAIL_LIMIT=100
```

## Enforcement

- The quota is checked before an email queue item enters `processing`.
- The successful-send counter increments only when an email queue item is first marked `sent`.
- Re-marking the same queue item as `sent` does not increment usage again.
- Once the quota is exhausted, processing or sending another email returns `DAILY_EMAIL_QUOTA_REACHED` with HTTP 429.
- Non-email channels do not consume the email quota.
- Usage is persisted in the prospect store and automatically uses a new date bucket each UTC day.

## Endpoint

```text
GET /api/outreach/quota
```

Optional historical date:

```text
GET /api/outreach/quota?day=2026-07-12
```

The response includes `limit`, `sent`, `remaining`, and `exhausted`.

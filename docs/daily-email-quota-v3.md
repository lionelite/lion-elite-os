# Daily Email Quota Deployment

Lion Elite OS enforces a default hard limit of 100 sent emails per UTC day. Configure with `DAILY_EMAIL_LIMIT`; inspect usage through `GET /api/outreach/quota`. The limit is checked before processing and atomically reserved when an email is marked sent.

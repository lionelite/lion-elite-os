# PostgreSQL Live Prospect Store

Lion Elite OS now uses PostgreSQL for prospect records, outreach queue items, audit events, and daily email quota usage when `DATABASE_URL` is configured.

## Runtime behavior

- `PostgresProspectStore` is selected in production when `DATABASE_URL` exists.
- The JSON `ProspectStore` remains available only as a local-development fallback.
- Existing API route contracts remain unchanged.
- Prospect fingerprints and outreach idempotency keys are enforced by database constraints.
- Queue status transitions and daily quota reservations are transactional.

## Render

Render injects `DATABASE_URL` from the managed PostgreSQL service. The build command runs `npm run db:migrate` before the web service starts.

## Health

`GET /health` reports the active store type and verifies database connectivity when PostgreSQL is enabled.

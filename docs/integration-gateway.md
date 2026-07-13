# LionOS Integration Gateway

This layer receives authenticated business events and normalizes them into the LionOS Redis/BullMQ automation fabric.

## Sources

- Shopify orders and customer events
- Gmail lead and support events
- Google Calendar appointment events
- Advertising performance events
- Authorized manual or internal events

## Security

- Shopify requests use `X-Shopify-Hmac-Sha256` verification.
- Gmail, Calendar, and Ads relay requests use an HMAC-SHA256 signature in `X-Lion-Signature`.
- Status and manual ingestion endpoints require `Authorization: Bearer <INTEGRATION_GATEWAY_TOKEN>`.
- Missing secrets fail closed.
- The gateway does not send customer communications or make irreversible changes.

## Endpoints

- `GET /health`
- `GET /status`
- `POST /webhooks/shopify`
- `POST /webhooks/gmail`
- `POST /webhooks/calendar`
- `POST /webhooks/ads`
- `POST /events/:source`

## Render deployment

Deploy `render-integrations.yaml` as a separate Render Blueprint connected to this repository.

Set the same Redis internal connection string used by the primary LionOS Blueprint as `REDIS_URL` on both new services. Add each provider webhook secret in Render. Render generates the internal gateway bearer token automatically.

Services:

- `lion-elite-integration-gateway`
- `lion-elite-integration-worker`

## Event flow

1. Provider sends an authenticated event.
2. Gateway verifies the signature and queues the raw event.
3. Integration worker normalizes the event.
4. The last 1,000 normalized events and per-source counters are maintained in Redis.
5. Revenue and lead signals automatically trigger the Executive Automation queue.

## Required next configuration

Provider credentials and webhook subscriptions must be configured in Shopify, Google, and the selected advertising platform. No credentials belong in GitHub.

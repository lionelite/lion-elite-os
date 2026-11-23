# LionOS Bluesky outreach webhook deployment

Deploy this as a separate Render Web Service from the `lionelite/lion-elite-os` repository.

## Render service settings

- Runtime: Node
- Build command: `npm install --no-audit --no-fund`
- Start command: `node social-listening/src/outreach-webhook-server.js`
- Health check path: `/health`

## Required environment variables

- `OUTREACH_WEBHOOK_TOKEN` — generate a long random secret. The outreach worker sends it as a Bearer token.
- `BLUESKY_HANDLE` — the Bluesky account handle that will send replies.
- `BLUESKY_APP_PASSWORD` — a Bluesky app password for that account. Never commit it to GitHub.

## Endpoint

After Render deploys the service, use:

`https://<your-render-service>.onrender.com/api/outreach`

as `OUTREACH_WEBHOOK_URL` for the outreach worker, and set the same `OUTREACH_WEBHOOK_TOKEN` on both the worker and webhook service.

The endpoint only accepts authenticated `POST /api/outreach` requests from the LionOS Bluesky listener payload format. It logs into Bluesky, loads the original post, preserves the thread root, and publishes the generated outreach message as a public reply.

A custom domain such as `outreach.lionelitewellness.com` can be attached to this Render service later. The root storefront domain cannot become this webhook merely by setting `OUTREACH_WEBHOOK_URL`; DNS/routing must point a hostname or path to the deployed service.

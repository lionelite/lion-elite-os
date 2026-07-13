# Gmail OAuth integration

Lion Elite OS can connect one Gmail or Google Workspace mailbox to import replies and stop active campaign sequences. It requests read-only Gmail access; outbound campaign sending remains controlled by the existing delivery provider and kill switch.

## Owner setup

1. Create a Google Cloud project and enable the Gmail API.
2. Configure the OAuth consent screen and add the mailbox owner as a test user until the app is verified.
3. Create a Web application OAuth client.
4. Set the authorized redirect URI to the exact value returned by `GET /oauth/google/connect`. The default is:
   `https://<integration-gateway-host>/oauth/google/callback`
5. In Render, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_APP_URL`, `GOOGLE_REDIRECT_URI`, `DATABASE_URL`, and `REDIS_URL`. Render generates the state and token-encryption secrets.
6. Call `GET /oauth/google/connect` with the integration gateway bearer token, open `authorizationUrl`, and approve access.

Never store Google credentials or tokens in GitHub. The refresh and access tokens are AES-256-GCM encrypted in PostgreSQL. Disconnecting removes the stored encrypted tokens.

## API

- `GET /oauth/google/connect` — returns the Google authorization URL and redirect URI.
- `GET /oauth/google/callback` — Google OAuth callback.
- `GET /gmail/status` — redacted connection and sync status.
- `POST /gmail/sync` — imports up to 100 inbound messages from the previous seven days.
- `POST /gmail/disconnect` — disables the connection and removes stored tokens.

Imported replies are idempotent. When the sender matches `prospects.contact.email`, the prospect moves to `replied`, pending/scheduled outreach stops, and an audit event is created.

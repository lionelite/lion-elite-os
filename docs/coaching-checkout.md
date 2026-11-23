# Coaching Checkout (Stripe)

How a stranger becomes a paying coaching client, and what has to be switched on
for that to work.

## Why this exists

The coaching product was finished and deployed — 30 API routes, 16 tables, the
PWA, invites, onboarding emails — and **could not be bought**. The repo could
already *receive* Stripe events (`lib/postgres-subscription-store.js` records
`invoice.paid` and `checkout.session.completed`) and could already grant access
(creating a coaching client sends an invite email automatically, via
`lib/coaching/invite-email-bootstrap.js`). The one missing piece was anything
that could charge a card. No `STRIPE_SECRET_KEY`, no checkout session, no
payment link anywhere.

## The flow

1. Someone opens **`/join/`** and enters their email.
2. `POST /api/checkout/session` creates a Stripe Checkout Session and returns
   its URL. The browser goes to Stripe.
3. They pay on Stripe's page. Card details never reach our servers.
4. Stripe posts `checkout.session.completed` to
   **`POST /api/checkout/stripe-webhook`**.
5. The signature is verified, then a coaching client row is created — which is
   what sends their invite email.
6. They land back on `/coaching/?checkout=success` with the invite already in
   their inbox.

## What the owner has to set

In the Render dashboard, on the **`lion-elite-os`** service. All four are
declared in `render.yaml` as `sync: false`, so they appear there ready to fill.

| Variable | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys (`sk_live_…`) |
| `STRIPE_PRICE_ID` | Stripe → Products → your coaching price (`price_…`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → the endpoint's signing secret (`whsec_…`) |
| `COACHING_PUBLIC_URL` | Your public origin, e.g. `https://lion-elite-os.onrender.com` |

Add the webhook endpoint in Stripe pointing at
`<COACHING_PUBLIC_URL>/api/checkout/stripe-webhook`, subscribed to
`checkout.session.completed`.

**The price is never set in code.** It lives in Stripe and is referenced by id,
so what a customer is charged is an owner decision that no deploy can change.
The tests assert that no `unit_amount` or `currency` is ever sent.

## Checking it

`GET /api/checkout/health` reports readiness without exposing any secret:

```json
{
  "checkoutConfigured": false,
  "webhookConfigured": false,
  "missing": ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"]
}
```

Use Stripe's test mode and a test card first. A test-mode payment runs the whole
path — session, webhook, client row, invite email — without real money.

## Fail-closed behaviour

Every failure mode refuses rather than pretending:

- No `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` → `/session` returns **503** and
  names what is missing. The join page says checkout is not switched on yet.
- No `STRIPE_WEBHOOK_SECRET` → the webhook returns **503** and processes
  nothing, because without the secret no signature can be verified.
- Bad, missing, tampered, or replayed signature → **401**, and no client is
  created. This matters: the endpoint is public, so without verification anyone
  could forge a `checkout.session.completed` and mint themselves free coaching.
- Provisioning genuinely fails → **500**, so Stripe retries. A customer who has
  paid but has no access is the one failure worth being noisy about.
- The same event redelivered → recognised as already provisioned. No duplicate
  client, no second invite email.

## Files

| File | Role |
|---|---|
| `lib/coaching/stripe-checkout.js` | Builds and creates the Checkout Session |
| `lib/coaching/stripe-webhook.js` | Signature verification and provisioning |
| `routes/checkout.js` | The three HTTP endpoints |
| `public/join/index.html` | The public purchase page |
| `test/coaching-checkout.test.js` | 22 tests, no network and no Stripe account needed |

Kept out of `routes/coaching.js` deliberately: that router enforces same-origin
on every POST, which is right for an app session and wrong for a Stripe webhook,
which arrives from Stripe with no `Origin` header and is authenticated by
signature instead.

No `stripe` npm package is used. The repo already calls Resend over plain
`fetch`, and matching that keeps the dependency list and the Render build
unchanged.

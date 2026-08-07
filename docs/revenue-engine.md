# Revenue engine — funnel events and the daily executive report

Issue #89, P1. This is the measurement layer for the automated revenue engine:
every revenue-relevant thing that happens across the three brands becomes an
append-only event, and one report turns those events into "how much came in,
where from, and which step is leaking".

## Why it exists

Before this, each subsystem had its own counters and none of them met. There was
no way to answer "did the affiliate lane make more than paid this week" or "where
do leads die", so optimisation was guesswork. Worse, a pipeline that produced
nothing looked identical to one nobody had instrumented — which is exactly how
the daily content engine sat dead for 16 days while reporting success.

## The event taxonomy

`lib/revenue/funnel-events.js`. Brands: `wellness`, `beauty`, `alexthelionlifts`.

Ordered acquisition funnel — order matters, the report walks this list to derive
conversion:

```
lead_created → consent_captured → welcome_email_sent → reply_received
  → qualified → offer_sent → purchase_completed → repeat_purchase
```

Coaching runs a **parallel** funnel, not a continuation: `coaching_application`
→ `coaching_close`. Someone can apply for coaching without ever buying a product,
so folding these into the list above would compute conversion over a denominator
that never applied.

Revenue events (`purchase_completed`, `repeat_purchase`, `coaching_close`) must
carry `amountCents`.

### Two rules the code enforces rather than documents

**The stage list is closed.** An unknown event type throws. A typo that silently
creates a new stage produces a report that looks fine and is wrong — the failure
mode this whole layer exists to eliminate.

**No PII.** Events carry an opaque `subjectId` and an optional salted
`subjectHash` (set `FUNNEL_HASH_SALT`). Metadata keys that look like PII —
`email`, `phone`, `first_name`, `address`, `ip`, … — are rejected. Revenue
analytics does not need identity, and keeping it out means this table can be
queried and exported freely.

An **unrecognised `source`** is normalized to `unknown` rather than rejected.
Losing a whole conversion because an ad platform invented a new UTM value would
be worse than reporting it unattributed.

## Emitting an event

```js
const { record } = require('./lib/revenue/funnel-store');

await record({
  type: 'purchase_completed',
  brand: 'wellness',
  source: 'affiliate',
  subjectId: order.id,
  subjectRef: order.email,      // hashed, never stored raw
  amountCents: 14999,
  eventKey: `stripe:${paymentIntent.id}`,
  metadata: { productId: 'ara-290-10mg' },
});
```

`eventKey` is the idempotency guard. Pass a natural one (a Stripe payment-intent
id, a webhook delivery id) whenever you have it; otherwise one is derived from
the event's identifying tuple. Replaying the same key is a no-op that returns the
stored row, so **a retried webhook cannot inflate revenue.**

## The report

```bash
npm run revenue:report              # yesterday → now
node scripts/revenue-report.js --days=7
node scripts/revenue-report.js --json
node scripts/revenue-report.js --sample   # worked example, no database
```

`--sample` renders a realistic day without touching Postgres, so the report can
be seen working before any emitter is wired.

Output gives revenue split into new / repeat / coaching, orders, paying
customers, AOV, the full funnel with stage-to-stage conversion, a **biggest
leak** line, and breakdowns by brand and by source.

Two deliberate details:

- Conversion uses the previous **non-zero** stage. If an emitter is never wired,
  later stages still report against the last real stage instead of dividing by
  zero and hiding where the pipeline actually stopped.
- Biggest leak is ranked by **people lost, not percentage**. A 90% drop on 3
  leads matters less than a 40% drop on 400.

An empty window prints an explicit "no events recorded — this is a real signal"
message rather than a clean-looking report full of zeros.

## Storage

`funnel_events` in `db/schema.sql`, applied by `npm run db:migrate`. Append-only,
`event_key` UNIQUE, `amount_cents` non-negative at the database level, indexed on
`occurred_at` and on `(brand, source, occurred_at)`.

CI provisions Redis but not Postgres, so nothing executes this SQL against a real
database in CI. `test/revenue-funnel-schema.test.js` is a source-text guard that
fails if the store and the schema drift apart — the same class of bug that put a
query against a nonexistent `audit_events` table into production.

## Scheduling

`render.yaml` runs `lion-elite-revenue-report` daily at 12:00 UTC. It reads and
reports only — it sends nothing and touches no customer.

## What this does not do

It measures; it does not sell. Nothing here flips `OUTREACH_SEND_ENABLED`,
`SMS_SEND_ENABLED`, or `SOCIAL_PUBLISH_ENABLED`, and consent and suppression
checks in the send paths are untouched.

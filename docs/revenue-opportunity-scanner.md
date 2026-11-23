# Revenue opportunity scanner

Scans every revenue signal Lion Elite already collects, ranks them against each
other, and names the single highest-value action that can actually happen right
now.

```bash
npm run revenue:scan
node scripts/revenue-scan.js --sample --aov=12000 --welcome-rate=0.08 --reorder-rate=0.22
node scripts/revenue-scan.js --json
```

Runs daily at 11:00 UTC as the `lion-elite-revenue-scan` cron.

## Why it exists

The signals were already being captured and were already being wasted, each in
its own silo with its own CLI:

| Source | Was doing |
|---|---|
| Gated signups (`member_leads`) | Sitting at `status: 'new'`, never contacted |
| Prior customers | No reorder prompt |
| Bluesky intent monitor | Logging people asking for a supplier to a JSONL file |
| Funnel leaks | Visible only if someone ran the revenue report |

Nothing ranked them against each other, so *"what is the single highest-value
thing to do right now"* had no answer, and the smallest easiest money went
unnoticed next to the loudest problem.

## What it produces

```
Opportunities found   8
Actionable now        5
Blocked               2
Human-only            3
Expected value        $189.74   (estimated items only)

DO THIS FIRST
  send client_research_reorder
  repeat1@example.com   (reorder_due_customer, EV $33.00)

RANKED QUEUE
  ready       $33.00   64d  repeat1@example.com          reorder_due_customer
  human       $42.24       lead_created → consent_captured  funnel_stage_leak
  BLOCKED     $50.60   90d  optout@example.com           reorder_due_customer
  ready        $9.60   38d  jordan@example.com           welcome_consented_lead
```

## Scoring

`score = (value × probability) / effort`, and blocked items are damped to 25%.

Effort is relative, not hours: `automated` (1) means a compliance-checked draft
already exists and only the send switch stands in the way; `light` (2) is a few
minutes per item; `manual` (5) is individual human attention.

That ratio is the point. A large payoff needing hours of manual work can and
should rank below a small one that is already automated.

`topAction` is the best thing that **can happen now**; `topOverall` may be
something blocked. The report shows both, so a blocked jackpot is visible
without displacing work you can actually do today.

## Two rules the code enforces

**Expected value is never invented.** Conversion rates are inputs. With none
supplied, every opportunity is still found and classified but reports value as
unknown — a made-up rate would reorder the entire queue while looking
authoritative. Pass `--aov` and the rate flags once you have measured numbers.

**Nothing gets silently upgraded to automatic.** Every opportunity carries
`automatable` and, when false, the reason:

- **Consent** — a customer without email consent, or suppressed, is `blocked` no
  matter how large their last order. Emailing them anyway is a CAN-SPAM problem.
- **Owner decision** — inbound social requests are always `automatable: false`.
  Auto-reply and auto-outreach on social were explicitly declined; it violates
  the no-customer-outreach limit, platform guidelines, and RUO marketing rules.
  `social-listening/` stays read-only, and the scanner must not reintroduce
  engagement as an "optimisation". Posts flagged do-not-engage are dropped
  entirely rather than ranked low.

Both are covered by tests, including one asserting a $1,000 non-consenting
customer never outranks a $10 consenting one.

## Missing data is reported as missing

If the member-lead database is not configured, the scan says so and explains
that those are consented signups currently invisible to it — it does not print
zero. Zero would read as "no opportunities", which is the opposite of the truth
and the exact failure mode that let the content engine idle for sixteen days
while reporting success.

## What it does not do

It finds, ranks, and recommends. **It does not send.** `OUTREACH_SEND_ENABLED`,
`SMS_SEND_ENABLED` and the Resend/Twilio credentials are untouched, and flipping
them remains an owner action.

## To make it see everything

1. `MEMBER_LEADS_DATABASE_URL` (or `TURSO_DATABASE_URL`) → the storefront's lead
   database, so consented signups are scanned.
2. `DATABASE_URL` → Postgres, for reorder-due customers and funnel leaks.
3. `--aov` plus real conversion rates, so the queue is ordered by money rather
   than by recency.

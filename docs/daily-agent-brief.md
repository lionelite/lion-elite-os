---
type: doc
tags: [agents]
---
# Daily agent brief

Every morning the agents read the live numbers for all three businesses and write one page: where revenue stands, the three things that need **you** today, what Claude and the agents are fixing, what is blocked, and a scoreboard per lane. It lands in Obsidian at `knowledge/daily/briefs/Latest.md` (and `YYYY-MM-DD.md`) at about 6:45 AM New York.

Back to [[knowledge/maps/AI Agents|AI Agents]] · [[knowledge/Home|Home]]

## Why this exists

The agent roster (`lib/agents/`) could plan, but nothing ever ran it: the runner was not scheduled anywhere, and it dispatched to Redis queues that do not exist on the free Render plan. The brief is the part that runs every day, on what the free setup actually has (one web service plus Supabase).

## How it runs

| Step | What | Where |
|---|---|---|
| 1 | 11:17 UTC: pg_cron calls the service | `db/supabase/agent-daily-brief-scheduler.sql` |
| 2 | Service runs the read-only metric queries | `lib/agents/brief-metrics.js` |
| 3 | Rules turn numbers into actions per lane | `lib/agents/daily-brief.js` |
| 4 | Brief stored, one row per New York day | `agent_briefs` table, `lib/agents/brief-store.js` |
| 5 | 11:47 UTC: workflow copies it into the vault, plus the open-PR backlog | `.github/workflows/daily-agent-brief.yml` |

Endpoint: `POST /run/agents/daily-brief` (`?async=1` answers at once) and `GET /run/agents/daily-brief/latest`. Auth is the same as `/run/clinic-outreach`: `OUTREACH_SECRET`, the brief's own pg_cron credential (`agent-daily-brief`, separate from the sender's), or GitHub OIDC from `daily-agent-brief.yml` on `main`. Run it by hand from the Actions tab: **Daily agent brief → Run workflow**.

## Who does what

Every action names the agent role that owns it (`lib/agents/roles.js`) and who has to act:

- **owner**: a decision or a gate only you can open (turning on sends, approving a message, spend, hosting). You get at most three a day, highest value first.
- **claude**: an engineering fix Claude makes through a pull request.
- **agent**: something the system already does on its own.

## What it watches

| Lane | Numbers | Examples of what it flags |
|---|---|---|
| Wellness | store orders (yesterday, 7 days vs the prior 7, 30 days), clinic pipeline stages, e-mails sent vs cap, replies, sender and discovery runs | replies to answer, 0 replies after 100+ contacts, revenue down week over week, top reason clinics are rejected, discovery or sender not running, outreach paused |
| Beauty & Coaching | coaching clients and check-ins, captured coaching leads | lead capture not connected, new leads to follow up within 24 hours, silent active clients |
| BuildPipeline | funnel events and applications | no live funnel, visits without applications, applicants to book |

## Honesty rules

- A number that could not be read shows **no data**, never 0, and the brief lists which query failed.
- Hold-backs ("eligible next run", "over today's cap") are reported as throughput, not as rejections.
- It reads and writes one row. It never sends, publishes, spends, or flips a control.
- Revenue only counts what is recorded in the database. Today that is Wellness store orders. Coaching and agency revenue are not recorded yet, and the brief says so.

## Changing it

Add a rule in `lib/agents/daily-brief.js` and a case in `test/daily-agent-brief.test.js`. Add a number in `lib/agents/brief-metrics.js` (SELECT only: the test refuses anything else).

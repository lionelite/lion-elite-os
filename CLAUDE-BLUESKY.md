# Claude Code — Bluesky Lead Intelligence

This file is the current source of truth for how Claude Code should use Bluesky lead intelligence in Lion Elite OS.

## Current architecture

Bluesky is no longer only a local two-lane review tool. The merged system now includes:

- Jetstream listener in `social-listening/src/monitor.js`.
- Universal lead-intent detection across niches.
- Niche classification and opportunity scoring.
- Durable PostgreSQL prospect storage when `DATABASE_URL` is available.
- Local JSONL mirror under `social-listening/data/` as a fallback.
- Lead enrichment and routing services from the Render lead automation suite.
- A read-only lead intelligence dashboard/API for ranking the strongest leads and niches.

Existing platform safeguards remain authoritative. Do not bypass channel authorization, opt-out/suppression rules, or Bluesky's explicit-tag requirement for automated replies.

## Claude Code operating rule

When the owner asks about Bluesky leads, revenue opportunities, niches, marketing opportunities, or lead-generation performance:

1. Run `npm run claude:bluesky`.
2. Read `claude-context/bluesky-leads.json`.
3. Prioritize leads by `score`, then buying/hiring intent, then recency.
4. Group leads by niche and report which niches have the strongest combination of volume and score.
5. For each high-priority lead, recommend a concrete marketing/sales angle based only on public lead context.
6. Never invent contact information. Use only public profile/post information and enrichment already stored by LionOS.
7. Never expose secrets or database credentials.

## Priority bands

- 80–100: immediate revenue opportunity; surface first.
- 70–79: high priority; prepare a specific marketing/sales action.
- 55–69: enrichment/nurture candidate.
- Below 55: monitor unless volume reveals an emerging niche.

## Data sources

`npm run claude:bluesky` uses PostgreSQL when `DATABASE_URL` is available. If PostgreSQL is unavailable, it falls back to the local Bluesky JSONL mirror so Claude can still reason over the leads collected on the owner's always-on laptop.

The generated `claude-context/bluesky-leads.json` is runtime context, not a source file. It should not contain secrets and should not be treated as permanent configuration.

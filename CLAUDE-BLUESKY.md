# Claude Code — Bluesky Lead Intelligence

This file is the current source of truth for how Claude Code should use Bluesky lead intelligence in Lion Elite OS.

## Current architecture

Bluesky is a native LionOS lead-intelligence source, not a separate manual tool. The system includes:

- Jetstream listener in `social-listening/src/monitor.js`.
- Universal lead-intent detection across niches.
- Niche classification and opportunity scoring.
- Durable PostgreSQL prospect storage when `DATABASE_URL` is available.
- Local JSONL mirror under `social-listening/data/` as a fallback.
- Lead enrichment and routing services from the Render lead automation suite.
- A read-only lead intelligence dashboard/API for ranking the strongest leads and niches.

Existing platform safeguards remain authoritative. Do not bypass channel authorization, opt-out/suppression rules, or Bluesky's explicit-tag requirement for automated replies.

## Always-on Claude Code integration

Claude Code must treat Bluesky lead intelligence as part of the standard LionOS operating context for marketing, sales, lead generation, niche analysis, revenue analysis, business-development strategy, and opportunity prioritization.

A Claude Code `SessionStart` hook automatically refreshes `claude-context/bluesky-leads.json` from the best available source. The owner should not need to run a special Bluesky command or function.

When working on any relevant business task, Claude should read `claude-context/bluesky-leads.json` when current lead evidence could improve the answer or decision. It should combine that information with the rest of LionOS rather than treating Bluesky as a standalone workflow.

Claude should:

1. Prioritize leads by `score`, buying/hiring intent, value signals, and recency.
2. Group leads by niche and identify which niches have the strongest combination of volume and quality.
3. Surface high-value prospects and concrete marketing/sales angles based on public context.
4. Use lead trends to inform content, offers, partnerships, and business-development priorities.
5. Never invent contact information. Use only public profile/post information and enrichment already stored by LionOS.
6. Never expose secrets or database credentials.

## Priority bands

- 80–100: immediate revenue opportunity; surface first.
- 70–79: high priority; prepare a specific marketing/sales action.
- 55–69: enrichment/nurture candidate.
- Below 55: monitor unless volume reveals an emerging niche.

## Data sources

The automatic context refresh uses PostgreSQL when `DATABASE_URL` is available. If PostgreSQL is unavailable, it falls back to the local Bluesky JSONL mirror so Claude can still reason over leads collected on the owner's always-on laptop.

The generated `claude-context/bluesky-leads.json` is runtime context, not source code. It is ignored by Git and must never contain secrets.

# GitHub-First Memory and Execution Protocol

## Owner directive

GitHub is the durable memory and operating source of truth for Lion Elite work.

Before answering or executing recurring Lion Elite tasks, agents should reference the relevant GitHub knowledge and operating files instead of relying on conversational memory alone.

## Required lookup order

1. `knowledge/` for verified recurring facts, links, positioning, and communication defaults.
2. `docs/LION_ELITE_OPERATING_CONTEXT.md` for durable operating and marketing context.
3. `docs/LION-ELITE-REVENUE-OPERATING-SYSTEM.md` for revenue priorities and decision filters.
4. `CLAUDE.md` for current technical architecture, autonomy, deployment, and hard limits.
5. Current GitHub issues, PRs, commits, and workflows for live engineering status.
6. Connected authoritative source (Calendly, Gmail, Calendar, Drive, Ads, analytics, etc.) when freshness matters or GitHub does not contain the answer.

## No-repeat rule

If a stable fact has already been verified and stored in GitHub, do not make the owner repeat it. Retrieve it.

## Missing-fact rule

When a required fact is absent:
- Query the connected authoritative source if available.
- Ask the owner only when the source cannot resolve it.
- Never fabricate or guess.
- If the fact is stable and useful in future work, add it to `knowledge/` through a normal PR.

## Freshness rule

GitHub is durable memory, not a substitute for live data. For changing facts such as today's sales, meetings, inbox state, ad performance, deployment state, or analytics, query the connected live source first and use GitHub for context and definitions.

## Sensitive-data rule

Never commit passwords, API keys, secrets, private customer records, health records, payment data, government IDs, or other sensitive personal information to the public repository.

## Revenue filter

For business execution, prefer work that directly:
- creates qualified demand,
- increases conversion,
- recovers revenue,
- improves retention or lifetime value,
- or makes those outcomes measurable and reliable.

Do not let memory maintenance become a substitute for revenue-producing execution.

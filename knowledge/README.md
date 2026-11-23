# Lion Elite Knowledge Base

This directory is the durable source of truth for recurring Lion Elite facts, links, brand rules, operating preferences, and business context.

## Mandatory operating rule

Before drafting, answering, planning, or executing a Lion Elite task, read the relevant files in this directory and the existing `docs/LION_ELITE_OPERATING_CONTEXT.md` when the task touches marketing, outreach, customer experience, websites, automation, or brand behavior.

Do not rely on conversational memory when a GitHub knowledge record exists. If conversation memory conflicts with GitHub, treat the current GitHub record as authoritative unless the owner explicitly updates it.

When a recurring fact is missing:
1. Query the connected source when available (Calendly, Gmail, Calendar, GitHub, Drive, Ads, analytics, etc.).
2. Never guess a URL, contact detail, price, credential, legal fact, or operational state.
3. Once verified, update the appropriate knowledge file through a normal branch/PR workflow.
4. Never store secrets, passwords, API keys, private customer data, medical records, or other sensitive credentials in this public repository.

## Index

- `scheduling.md` — verified scheduling identities and links.
- `brands.md` — brand positioning and customer-facing constraints.
- `equity-trust.md` — recurring Equity Trust communication context.
- `execution-rules.md` — GitHub-first memory and execution protocol.

## Existing durable context

Also read:
- `docs/LION_ELITE_OPERATING_CONTEXT.md`
- `docs/LION-ELITE-REVENUE-OPERATING-SYSTEM.md`
- `CLAUDE.md` for architecture, security boundaries, deployment behavior, and autonomy rules.

## Update standard

Every record should distinguish:
- **Verified** — read from a connected authoritative source or directly confirmed by the owner.
- **Owner-stated** — supplied by the owner but not independently verified.
- **Operational inference** — useful interpretation that must not be presented as a verified fact.

The goal is continuity: future ChatGPT, Claude Code, and LionOS sessions should retrieve the same verified facts instead of repeatedly asking the owner for information already established.
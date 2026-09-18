# AI agent roster — roles, knowledge, and the daily coordination loop

Implements Issue **#73** ("Make AI agents execute against the daily revenue
target"). Seven agents with defined business roles, each grounded in the repo's
own data, coordinated by an executive loop that measures the revenue gap through
the day and reassigns effort.

**Read this first:** most of what these agents would most like to do is gated
off, deliberately. Sending needs `OUTREACH_SEND_ENABLED`; publishing needs
`SOCIAL_PUBLISH_ENABLED`; paid media needs an owner-approved cap. Those switches
belong to the owner. This module never flips them, never routes around them, and
never reports work that did not happen. A blocked assignment comes back as
`blocked`, naming the control and the remedy. An agent roster that claimed
"outreach sent" while the kill switch was on would be worse than no roster.

## The problem this replaces

The same six agents were described twice, with nothing reconciling them:
`ai-agents/*.md` (design docs read by no code) and six inline `systemPrompt`
strings in `server.js`. CLAUDE.md records the consequence — "the two can and do
drift apart with no enforcement."

`lib/agents/roles.js` is now the single source of truth for each role's mandate,
KPIs, knowledge domains and dispatchable actions. `server.js` imports it,
validates it at startup, and **throws if its roster disagrees** — drift is a boot
failure instead of a silent divergence. The prompts stay in `server.js`, because
they encode real brand rules worth keeping.

## The roster

| Role | Owns the decision | Gated by |
|---|---|---|
| **Executive** | Which agent works on what, in what order, today | — |
| **Sales** | Which specific leads get worked next, and in what order | `OUTREACH_SEND_ENABLED`, `SMS_SEND_ENABLED` |
| **Marketing** | What creative gets made, and which pieces are good enough to go out | `SOCIAL_PUBLISH_ENABLED`, ad spend cap (owner decision, no env var) |
| **Client Success** | Which existing customers are due contact, and through which brand | `OUTREACH_SEND_ENABLED`, `SMS_SEND_ENABLED` |
| **Operations** | Which operational exception is escalated now | — |
| **Finance & KPI** | What the revenue number actually is, and how much is attributable | — |
| **Research Compliance** | Whether customer-facing copy may leave the building | — (**has veto**) |

Every role must own a decision, carry at least one KPI, and declare a knowledge
domain — `validateRegistry()` fails otherwise. A role that owns no decision is a
report, not an agent.

Two deliberate asymmetries:

- **Research Compliance has a veto and no revenue KPI.** Giving the compliance
  role a revenue target would put it in conflict with the thing it exists to
  enforce. It is pulled into any plan containing customer-facing copy, and it runs
  *before* drafts go anywhere.
- **Client Success was missing from the dashboard roster entirely** before this
  pass, despite being one of #73's six named agents. Added.

Actions are validated against the dispatcher's allowlist
(`lib/action-catalog.js`), so no role can declare something that would be refused
at run time — and no role can name anything on `BLOCKED_ACTIONS` (`send-email`,
`publish-content`, `charge-payment`, `deploy-production`, …). That is enforced by
test, per role, per blocked action.

## Knowledge — agents grounded in your own data

`lib/agents/knowledge.js` indexes each role's declared domains and extracts
facts: structure (headings), directives (decisions the business has made), stated
numbers (money, percentages, rates), and datasets. Current coverage:

```
executive              5 sources   164 facts
sales                  8 sources   225 facts
marketing              7 sources   144 facts
client-success         6 sources   130 facts
operations             7 sources   166 facts
finance-kpi            6 sources   205 facts
research-compliance    4 sources    97 facts
                                  1,131 facts total
```

Four properties that matter more than the count:

- **Every fact carries `file` and `line`.** The same discipline the video-learning
  module applies with timestamps: an agent assertion nobody can trace is an
  assertion nobody should act on. A test spot-checks that citations point at real
  lines containing the cited text.
- **Deterministic and offline.** No model call, no network, no secrets. The same
  repo state always produces the same knowledge base, so a change in an agent's
  behaviour is attributable to a change in the data. Optional LLM summarisation
  can sit on top; the base layer works with zero configuration.
- **Missing sources are reported, never skipped.** A role pointing at data that
  is not there is a broken agent, and it must be visible rather than degrading
  into a quietly thinner corpus. This immediately caught a real problem — see
  below.
- **Sources quoting dosing or human-use language are marked `internalOnly`.**
  Several compliance documents quote the phrasing they exist to prohibit. An agent
  that indexes those and parrots them into customer copy is a compliance
  incident, so the wording is quarantined while the rule stays usable. Same
  treatment video-learning gives creator transcripts: adopt the mechanism, never
  the wording.

### Finding: Issue #41 points at a file that does not exist

Issue #41 directs that `docs/core-sales-framework.md` be "the core of anything
Lion Elite sells or communicates." **That path has never existed in this repo.**
The actual framework is `sales/master-sales-framework.md`. The registry points at
the real file; the issue's path needs correcting so nobody else builds against a
ghost.

## The coordination loop

`lib/agents/coordinator.js`. #73's definition of done is that the brief does not
merely state the target — it triggers work, records outcomes, measures the gap
during the day, and redirects effort. So this produces **assignments**, not prose.

**Gap is measured against pace, not just total.** $500 collected means something
very different at 9am than at 7pm, so `revenueGap()` compares collected revenue
to where we should be by this hour of a 8am–8pm working day. Default target
$3,500, stretch $5,000 (Issue #73), both env-overridable.

**Four checkpoints**, each of which must establish something concrete:

| Checkpoint | Establishes |
|---|---|
| morning | Today's target, the gap, and the opening assignment set |
| midday | Contacted, replies, qualified, checkouts, collected revenue, publication status |
| afternoon | Whether we are behind pace, and which highest-intent work gets the rest of the day |
| evening | Collected revenue, pipeline created, conversion by source, failures, carryover |

**Behind pace → revenue roles outrank support work.** Assignments are ordered by
expected impact, and sales/client-success are prioritised above
marketing/operations/finance when the day is behind.

**Target met → stop pushing volume.** Once the number is hit the plan switches to
verification (finance reconciles, operations checks nothing is stuck) rather than
assigning more outreach. Pushing volume after the number is hit is how a good day
becomes a compliance incident.

**A day where everything was blocked says so.** `dayReport()` returns *"Every
assignment was blocked (OUTREACH_SEND_ENABLED, …). The agents produced no outward
effect today; a human has to open a gate."* That sentence is the whole honesty
posture of this module.

## Commands

```bash
npm run agents:roster                              # the authoritative registry
npm run agents:knowledge                           # coverage across all roles
npm run agents:knowledge -- sales                  # one role's sources and citations
npm run agents:recall -- sales "build value before price"
npm run agents:plan -- --collected 900 --hour 16 --checkpoint afternoon
npm run agents:plan -- --collected 900             # all four checkpoints
```

## What is deliberately not built

- **No new send path.** The agents request allowlisted queue jobs through the
  existing dispatcher. Everything outward-facing stays behind the controls in
  CLAUDE.md's hard limits.
- **No switch flipping.** `OUTREACH_SEND_ENABLED`, `SMS_SEND_ENABLED` and
  `SOCIAL_PUBLISH_ENABLED` are owner actions in the Render dashboard; all three
  are documented in `.env.example`, defaulted off.
- **No phantom gates.** The first version of `coordinator.js` named
  `AD_DAILY_SPEND_CAP` as the ad-cap control — a variable **nothing else in the
  repo reads**. A gate that opens on a variable governing nothing looks like
  authorization while providing none, which is strictly worse than having no
  check. There is no env var for the ad cap: `lib/ads/` generates plans and spends
  nothing, and per CLAUDE.md the cap is established out of band by the owner, so
  the control is now a human decision no variable can satisfy. A regression test
  greps every named control's env var outside `lib/agents/` and fails if one is
  invented again.
- **No LLM dependency in the core.** The registry, knowledge base and coordinator
  are pure and deterministic. `server.js` keeps its optional OpenAI path for prose
  generation, exactly as before.

## A refactor this needed

`lib/action-catalog.js` is new: the action vocabulary extracted out of
`openai-action-dispatcher.js`, which requires `job-queues` → `bullmq` → a Redis
connection. Anything wanting to *reason about* which actions exist had to drag a
live queue client in to read two frozen objects. Same extraction and same reason
as `lib/integration-normalization.js`. The dispatcher re-exports both constants,
so every existing consumer is unaffected.

Tests: `test/agent-roles.test.js`, `test/agent-knowledge.test.js`,
`test/agent-coordinator.test.js` — 53 tests in the root `npm test`.

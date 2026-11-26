# Python bot community (`bots/`)

A standing team of Python bots, each owning a named set of skills, sharing one
durable task board. You hand work to the community, in plain English or as a
specific skill. The right bot picks it up and the result is recorded with an
honest status.

```bash
npm run bots -- roster                       # every bot and skill
npm run bots -- ask "plan the shapewear launch for Jan 15"
npm run bots -- submit fba.profit '{"price":34.99,"landed_cost":7.5,"fba_fee":5.4}'
npm run bots -- serve --workers 4            # stay up; work tasks as they arrive
npm run bots -- list                         # recent tasks
npm run bots -- show <task id>               # full result
npm run bots:test
```

`ask` and `submit` run the task right away and print it. With `--queue-only`
they leave the task for a running `serve`. The task board is SQLite at
`bots/.state/lionbots.db`, or wherever `LIONBOTS_DB` points. It is gitignored
because payloads and results (clinical briefs, deal numbers, margins) stay local.

## The bots

| Bot | Skills | Needs |
|---|---|---|
| `memecoin` | `lookup` (DexScreener pairs), `screen` (rug/risk flags), `size` (loss-capped allocation) | network for `lookup` |
| `fba` | `profit` (unit economics, breakeven ACoS), `screen` (product idea; stops restricted categories), `listing_draft` | Claude for `listing_draft` |
| `research_peptides` | `literature` (PubMed), `copy_check` (RUO validator), `product_copy` (RUO-gated draft) | network, Claude, node |
| `clinical_peptides` | `trials` (ClinicalTrials.gov), `literature` (clinical PubMed), `evidence_brief` (cited, internal only) | network, Claude |
| `brand_alex` | `week_plan` (@alexthelionlifts pillars, ~2/7 posts carry a CTA), `captions`, `check` | Claude, node |
| `buildpipeline` | `funnel_copy` (VSL config + script), `validate_funnel`, `funnel_report` | Claude, node |
| `shapewear` | `launch_plan`, `economics`, `size_chart` (gaps/overlaps), `copy` (claim-checked) | Claude, node for `copy` |
| `finance` | `analyze_property`, `tax_estimate` (finance-intelligence/) | — |
| `repo` | `search`, `read`, `script` (allowlisted read-only npm scripts) | git, npm |
| `compliance` | `check` (lib/social/social-compliance.js) | node |
| `claude` | `ask`: anything no specialist owns | Claude |
| `ops`, `triage` | `status`, `ping`; holds unroutable requests | — |

**Claude** means `pip install -r bots/requirements.txt` plus credentials:
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile.
The model is `claude-opus-5-5` at `medium` effort, with server-side refusal
fallback on. `LIONBOTS_MODEL` and `LIONBOTS_EFFORT` override the model and
effort. Every other bot is stdlib-only.

**Network:** PubMed, ClinicalTrials.gov and DexScreener are public and keyless.
The dev sandbox's proxy refuses all three, so those skills return `blocked`
there and work on any normal machine.

## Statuses

| Status | Meaning |
|---|---|
| `done` | The bot finished. For drafts this still does not mean "approved": read `customer_ready`. |
| `blocked` | It needs something only a human can provide: a key, a package, network access. The error names the gate. |
| `needs_human` | No bot owns this work, or Claude declined it. |
| `refused` | It crosses a hard limit. Recorded and never queued. |
| `failed` | Bad input or a bug. Retryable errors get one automatic retry first. |

## What the bots will not do

`lionbots/guardrails.py` checks every request and every skill name a bot
declares. A bot that declares a skill such as `email.send` fails registration.
The guardrails refuse:
- sending e-mail, SMS or DMs, and bulk messaging;
- posting, replying, liking or following on social platforms;
- buying, paying, upgrading plans, or raising spend;
- flipping any send switch or the kill switch;
- force-pushing, merging to main, or deleting production data;
- printing secrets.

Asking for a *draft* of a message or post is fine. Drafts carry `sent: false` or
`published: false`.

Some rules are enforced in the bot code itself rather than in a prompt:
- **Customer copy is gated by the repo's own validator.** `customer_ready` is
  true only when `lib/social/social-compliance.js` ran and approved the text.
  If Node is missing, the draft is labelled unchecked, not passed. RUO copy
  must carry the validator's exact phrase, "laboratory research purposes only",
  and no mg/mcg/IU/mL quantities, because the validator reads those as dosing.
- **Clinical briefs are always `internal_only`.** Discussing what trials studied
  is exactly the language RUO storefront and outreach copy may not carry.
- **Meme coins are never traded.** A screen can fail a token but never clears
  it. Position size is capped at a share of bankroll however tight the stop is,
  because meme coins gap through stops.
- **FBA fees are never guessed.** `fba.profit` requires the real FBA fee.
  `fba.screen` stops research chemicals, peptides and injectables, which Amazon
  restricts or bans.
- **Shapewear copy is claim-checked** for inch or fat loss, waist training,
  medical or post-surgical use, permanence and guarantees, which are FTC and
  platform problems for garments. Launch facts that don't exist yet are listed
  as `missing_facts`, not invented.
- **@alexthelionlifts is drafts only.** That account isn't in the social
  publish pipeline, so the owner posts.

## Adding a bot

Create one file in `bots/lionbots/bots/`. It is discovered automatically:

```python
from ..bot import Bot, done, failed, skill

class InventoryBot(Bot):
    name = "inventory"
    description = "Stock levels and reorder points."
    keywords = {"inventory.reorder": ["reorder", "low stock"]}

    @skill("inventory.reorder")
    def reorder(self, task):
        """payload: on_hand, daily_sales, lead_time_days."""
        ...
        return done({...})
```

Skill names are `area.verb`. The docstring's first line is what `roster` shows,
and it is also what the router gives Claude when filling fields from plain
English. A bot raises `BotError` for a retryable failure. It returns
`blocked(reason, gate)` when a human has to provide something. For outside
dependencies it can simply let `LLMUnavailable`, `SourceUnavailable` or
`NodeUnavailable` propagate, and the runner turns them into `blocked`.

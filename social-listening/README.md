# Bluesky Social Listening Monitor

Real-time, **read-only** monitor of the Bluesky firehose that surfaces two
kinds of conversations for human review:

- **research-peptides** (Lion Elite Wellness lane): researchers/lab buyers
  publicly asking about peptide sourcing, vendors, COAs, purity.
- **personal-training** (Lion Elite Beauty lane): people publicly saying
  they're looking for a trainer, coach, or a way to start training.
  (The firehose exposes public posts, not searches — a public "any trainer
  recommendations?" post is the strongest available version of that signal.)

## What this tool deliberately does NOT do

- It has **no Bluesky credentials** and **no write path to any platform**.
  It never replies, posts, likes, follows, or DMs.
- It does not auto-send the suggested openers anywhere. They are drafts a
  human may adapt and send **manually from their own account** after
  reading the post — mirroring the repo-wide rule that outreach drafts are
  for human review, never automatic sending (`CLAUDE.md` hard limits;
  incident #37).
- Posts showing **human-use intent** toward research compounds (dosing,
  injecting, cycles, "I'm on…") are surfaced with a hard **DO NOT ENGAGE**
  flag and no suggested opener. Research-use-only products must not be
  marketed to personal-use interest (`docs/customer-communication-rules.md`).
  Automated replies to strangers would also violate Bluesky's community
  guidelines — engagement stays a per-post human decision.

## Running it

Requires Node 22+ (uses the built-in WebSocket; bun also works). No extra
dependencies. Run it from a machine with normal network access — sandboxed
CI/agent environments typically block WebSocket upgrades.

```bash
npm run listen:bluesky          # live monitor (both audiences)
npm run listen:review           # http://localhost:4600 review dashboard
npm run listen:replay           # offline demo through the same pipeline

node social-listening/src/monitor.js --audience=research-peptides --min-score=50 --no-model
```

The monitor connects to a public Jetstream instance
(`jetstream{1,2}.us-{east,west}.bsky.network/subscribe?wantedCollections=app.bsky.feed.post`),
rotating hosts with exponential backoff on disconnects and resuming from
the last cursor. English-language posts are scored by
`src/classifier.js`; matches print live and append to
`social-listening/data/matches-YYYY-MM-DD.jsonl` (gitignored — third-party
content stays local).

## How classification works

Deterministic and explainable (`src/audience-profiles.js`): a post must hit
at least one **subject** term (peptide/compound/supply vocabulary from
`lion-elite-wellness/product-master-list.md`, or training/coaching
vocabulary) **and** at least one **intent** term (buy/source/vendor/
recommend… or looking-for/hire/where-do-I-start…). Context boosters (lab,
COA, in vitro… / beginner, accountability…) raise the score. Every match
records exactly which terms fired.

### Optional local model (Ollama)

If [Ollama](https://ollama.com) is running locally (`OLLAMA_URL`, default
`http://localhost:11434`; `OLLAMA_MODEL`, default `llama3.2`), each
keyword match is refined by the local model: intent labeling
(`purchase_seeking` / `coach_seeking` / `discussion` / `news` /
`promotion`), human-use detection, and confidence. Model output can only
make results **more** conservative — it can force DO NOT ENGAGE or mark a
match low-priority, never un-flag one, never trigger any action. Without
Ollama the monitor runs in keyword-only mode. No cloud AI calls either way.

## Review workflow

1. Keep `npm run listen:bluesky` running (a cheap always-on box is fine).
2. Open `npm run listen:review` → filter by audience, skim new matches.
3. For a promising post, click through to bsky.app and decide yourself
   whether a reply is genuinely helpful in context. Adapt the suggested
   opener; don't paste it verbatim at scale — repetitive commercial
   replies are spam by any platform's definition and will get the account
   moderated.
4. Never engage flagged posts (red cards). For the Wellness lane that flag
   is a compliance boundary, not a suggestion.

`GET /api/matches` returns the same data as JSON if you want to feed a
different surface later (e.g., the `prospects` store as a research-signal
source — not wired up yet, deliberately).

## Files

| File | Purpose |
|---|---|
| `src/jetstream.js` | Jetstream WebSocket client (reconnect, cursor resume, event parsing) |
| `src/audience-profiles.js` | Audience term sets, do-not-engage rules, suggested openers |
| `src/classifier.js` | Word-boundary synonym/keyword scorer |
| `src/ollama-intent.js` | Optional local-model refinement (conservative-only) |
| `src/monitor.js` | Live CLI monitor |
| `src/review-server.js` | Local review dashboard (port 4600) |
| `src/replay.js` | Offline pipeline demo/tuning harness |
| `src/store.js` | JSONL match store (`data/`, gitignored) |

Like `real-estate/` and `business-scaling/`, this is a standalone module:
no Render service, no queues, no database. Tests run in the root `npm test`.

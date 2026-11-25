# Wallet Watch — Solana trader monitor

Tracks up to 5 Solana wallets, alerts on their buys and sells in Telegram, and paper-trades a
simulated $250 portfolio that copies them. **Monitoring and simulation only**: nothing here holds
a private key, signs a transaction, or trades real money. Live trading needs a separate, explicit
owner decision after reviewing the simulation.

## Where it runs

| Piece | Where |
|---|---|
| Monitor + API | Supabase Edge Function `sol-tracker` (project "Lion Elite OS Backend") — `supabase/functions/sol-tracker/` |
| Schedule | `pg_cron` job `sol-tracker-tick` every minute → `/tick`; `sol-tracker-research` every minute → `/research/step` |
| Data | `sol_*` tables (schema in `supabase/migrations/001_sol_tracker.sql`), RLS on, no policies — only the function's service role can read/write |
| Dashboard | `public/wallet-watch/index.html`, served by the `lion-elite-os` Render service at `/wallet-watch/` (copy of `dashboard/index.html`) |

## How a trade becomes an alert

1. Each tick reads new signatures for every active wallet from its saved cursor (`sol_wallets.last_signature`),
   so a restart or outage resumes where it stopped — nothing is skipped, and a gap over 10 minutes is logged
   (and sent to Telegram) as a recovery.
2. Each transaction is classified by `parseSwap()` (`lib.ts`): **BUY** = wallet paid SOL/WSOL/USDC/USDT and
   received a token; **SELL** = the reverse; a token moving with no payment is a **transfer** and never alerts.
3. Trades are stored once per `(signature, wallet)` (primary key), so duplicates are impossible.
4. Buys under `min_buy_sol` (default 0.5) are stored as `below_threshold`; every sell alerts, marked FULL or
   PARTIAL (with %) from the wallet's token balance before/after.
5. Telegram delivery retries up to 5 times; alerts older than 2 hours when Telegram becomes available expire
   instead of flooding the chat. Market data (DexScreener) and mint/freeze authority flags are labelled as such.

## Trader research

`POST /research` queues candidates. With `HELIUS_API_KEY` set, the research job lists each wallet's swap
transactions for 90 days (Helius by-address history, `type=SWAP`), fetches every one over RPC, classifies it
with the same `parseSwap()`, and computes realized results with average-cost basis (`researchMetrics()`):
30/60/90-day realized SOL, per-month split, win rate by token, best-token concentration, drawdown, buy sizes,
hold times, sub-60-second flips, and proceeds from tokens never bought (airdrops/transfers — excluded from profit).
`assess()` applies ten pass/fail rules; the dashboard shows every rule and its numbers.

**Two tiers (2026-11-24).** Five rules are *core*: history covers the window, profitable over 30/60/90
days, 20+ closed positions, copyable size, still active. A wallet passing all core rules is put on the
**paper** watch list (label `(watch)`), with the failed non-core rules listed as cautions; passing every
rule makes it `verified`. Requiring every rule just to paper-watch rejected all 103 wallets researched,
including six with real 30/60/90-day profit, and left only Kolscan names whose paper copies all lost.
Slots (max 5) go verified first, then checks passed, then 90-day profit (`rankWatch()`); a verified
wallet can displace a watch-tier one, nothing displaces a `copy_live` wallet. Real money is unchanged:
it still needs the scorecard (20+ paper trades, net positive) and your Telegram approval.
`POST /research/promote` re-assesses finished research with the current rules and fills the list.

Known limits: SOL-quoted trades only (stablecoin-quoted trades are counted and excluded); open positions are
excluded (unrealized); token liquidity at the time of each historical trade is not reconstructed.

## Discovery (finding wallets to research)

`pg_cron` job `sol-tracker-discover` calls `/discover/step` every minute while a scan is running, and starts
a new scan 6 hours after the last one finished once the research queue is empty. A scan:

1. takes trending Solana pools from GeckoTerminal (24h move ≥ 20%, liquidity ≥ $30k);
2. reads each pool's last ~1,500 swaps (Helius parsed history) and attributes every swap to its fee payer
   as a buy or a sell (`poolSwapSide()`), giving each wallet's SOL in vs SOL out on that coin;
3. keeps a seller only if it **also bought** in the window, came out ≥ 1 SOL ahead, at an average buy of
   0.3–15 SOL, with ≤ 40 swaps on the coin (`discoveryVerdict()`). Every verdict is stored on
   `sol_discovery_hits.verdict`;
4. ranks survivors by number of different coins profited on, then profit, and spends **one**
   `getSignaturesForAddress` page per candidate to drop wallets whose entire history is younger than the
   research window (`historyTooShort()`, which those wallets would fail for certain);
5. queues the best 10 for full 90-day research. The funnel counts go to `sol_events` and Telegram.

Why: the first two scans queued any wallet that sold ≥ 1 SOL, and research rejected all 40. Most had sold
far more than they ever bought (dev, bundle, or airdrop wallets) or were days old. Known trade-off: a
real trader whose buy predates the ~1,500-swap window is dropped at step 3.

## Entry filter (paper and live buys)

Owner decision 2026-11-23, from a video lesson ("avoid rugs: lots of holders, high market cap, high
volume, a website and Twitter"), checked against our own data first. All 35 closed paper trades with
market data failed it, losing $161.89 (avg −24.8%). The copied traders' buys had a median $9.9k market cap
and were 12 minutes old. `entryCheck()` (`lib.ts`) skips a copied buy unless, at detection:

- market cap (DexScreener FDV) ≥ $1M
- 24h volume ≥ $250k
- the token lists a website or Twitter
- the pair is ≥ 1 hour old (a stand-in for "lots of holders", which our market data doesn't include)

- at least **500 holders** and no **danger**-level RugCheck risk (for example top-10 concentration or a
  rug), from RugCheck's free report API (`api.rugcheck.xyz/v1/tokens/<mint>/report`, cached 10 min,
  only called for coins that already pass the cheap checks). This replaced pair age as the measure of
  "lots of holders"; pair age is kept as an extra check. Discovery applies the same holder rule to its
  coin list. `GET /entry-check?mint=<mint>` answers "would we buy this right now, and why not?".

Missing data fails closed. Adjust with `POST /settings {"entry": {...}}`; `{"entry": {"enabled": false}}`
turns it off. Skips are written to the paper ledger as `Entry filter: <reasons>`.

Discovery uses the same thresholds: it scans only pools whose coin passes them, is ≥ 24h old with ≥ $50k
liquidity, is quoted in SOL/USDC/USDT, is under a $100M market cap (above that the profitable sellers are
market makers, not copyable traders), and is up on the day. Research adds an 11th check, "Buys established coins": fewer than 50% of
the trader's buys within 1 hour of the token's launch (`earlyBuyShare()`, launch times from DexScreener,
300 most recent tokens).

`POST /paper/reset` now closes open paper positions instead of deleting them, and results count from the
latest reset marker.

## Execution via Jupiter Ultra, optional Birdeye discovery (2026-11-23)

**Ultra.** Live swaps use Jupiter Ultra (`lite-api.jup.ag/ultra/v1` `/order` then `/execute`, no API key).
Measured on a 0.25 SOL meme-coin buy, compared with our previous v1 quote+swap at 15% slippage:

- Ultra set **1%** slippage itself, so the room a sandwich bot can take shrinks from ~15% to ~1%.
- The priority fee was ~0.000025 SOL instead of up to 0.001.
- Jupiter charges 0.1% (`feeBps` 10).
- Sending goes through Jupiter's own landing, not the public mempool.

The signature is computed before `/execute`, so a lost response still leaves a trackable transaction. If
Ultra is rate-limited or down (HTTP 429/5xx on `/order`), live falls back to v1 with slippage capped at 5%.
Paper prices every fill with the same Ultra order, including its network fees. `POST /live/dry-run` builds
and signs an Ultra order without sending it.

**Birdeye (optional).** With `birdeye_api_key` in the `sol_settings` secrets row (or `BIRDEYE_API_KEY`),
discovery also asks Birdeye for the 10 most profitable wallets of the month (`top_traders`, 30d,
`realized_pnl`) on 6 of the established coins per scan. It skips wallets tagged as bot, sniper, MEV,
arbitrage, market maker, insider or dev. Those wallets still go through the same history check and 90-day
research. Budget: about 6 × 35 compute units per scan, 4 scans a day, which fits Birdeye's free 30k
units a month. Only the documented `owner` and `tags` fields are read. Not exercised yet: no key is set.

## Paper/live parity, realistic fills, scorecard (2026-11-23)

Paper trading is only evidence for live trading if both follow the same rules, so:

- **One rule set.** `copyRules()` (`lib.ts`, config key `copy`) drives both paths: buy size (`buy_sol`, the
  same SOL amount live spends), the confirm-hold (0 s since 2026-11-25 for the owner's 1 to 2 s copy target; 2 s from 2026-11-23, 60 s before; when above 0, a buy is skipped if the trader already sold — live
  now does this too), our own stop-loss −25% / take-profit +50% sells half once (`riskExit()`, now on live
  positions as well), and max open positions.
- **Real fills.** Paper buys and sells are priced with a real Jupiter quote at fill time (DEX fees and
  price impact included) plus the priority fee. The ledger notes the total cost against the market price. A
  sell with no route is estimated and labelled `ESTIMATED`.
- **Scorecard** (`traderScore()`, hourly): per trader, paper copies closed since the last reset. **Eligible**
  = ≥ 20 trades, net positive, average ≥ +2% per trade. An eligible trader gets a Telegram message with
  **Approve live / Not now** buttons. Approval sets `copy_live` and stage `live`; nothing else turns real
  money on. A live trader whose last 10 paper copies lost money overall is **demoted** automatically.
  `GET /scorecard` shows it.
- **Live safety:** buying switches itself off when realized live P/L reaches −`max_loss_sol` (1.5 SOL,
  i.e. 30% of the 5 SOL cap). A low-balance alert fires at most once a day.
- **Daily summary** in Telegram at 9 pm New York (`POST /summary` sends one now): paper P/L since the reset,
  the last 24 h, top skip reasons, the trader scorecard, research results, and live state.

## Live copy trading (real money)

Owner decision 2026-11-22: copy the Kolscan **daily** leaderboard ranks 15–20 (Smokez, Tuults, Iced,
Idontpaytaxes, yeekidd, Wugi) with **0.25 SOL per buy and a 5 SOL lifetime cap**. Only wallets with
`sol_wallets.copy_live = true` are copied; every other wallet stays monitor-only.

- **Key:** the owner's own wallet secret, set as the `LIVE_TRADER_KEY` Edge Function secret (base58 or the
  JSON byte array). It is never stored in the database, logged, or returned by the API. Without it, every
  copied trade is recorded as `skipped`.
- **Buys** pass `liveBuyDecision()` (`lib.ts`): enabled, key set, trader's own buy ≥ 0.25 SOL, not already
  holding, spend cap not exceeded by this buy, ≤ 8 open positions, 0.03 SOL fee reserve kept, liquidity ≥
  $10k, no freeze authority, detected ≤ 120 s after their buy. The spend is reserved before sending.
- **Sells** mirror the trader's exit (`liveSellAmount()`: FULL sells all, PARTIAL the same fraction), only for
  positions opened copying that trader. They run even with buying switched off. A failed sell retries 3 times,
  then Telegram says so loudly.
- **Execution:** Jupiter quote + swap, signed in the function, sent with preflight on. Orders live in
  `sol_live_orders`, are unique per (copied trade, side), and are claimed atomically, so overlapping ticks
  cannot double-submit. Positions are in `sol_live_positions`.
- **Controls (dashboard token):** `GET /live` (wallet, balance, spend, positions, orders), `POST /live/config`
  (any `LiveCfg` field, e.g. `{"enabled": false}`), `POST /live/sell-all` (stop buying, sell everything),
  `POST /live/dry-run` (build and sign a real swap, never send).
- **Known limits:** detection runs on the 1-minute tick, so copies land roughly 10–70 s after the trader.
  There is no stop-loss: a position closes only when the trader sells via a swap we detect. If they move the
  tokens out instead of selling, use sell-all or sell manually.

## Deploying

The deployed `index.ts` is a stub that imports this directory's `index.ts` from GitHub at one pinned commit
SHA. Supabase bundles it at deploy time, so what runs cannot change without a redeploy. To ship a change,
push it, then redeploy the stub with the new SHA. The stub is used because the function is too large to
paste through the deploy API reliably.

## Secrets (Supabase → Edge Functions → Secrets)

- `TELEGRAM_BOT_TOKEN` — from @BotFather. Then message the bot `/start` and press **Link my Telegram chat**.
- `HELIUS_API_KEY` — free plan at helius.dev. Enables research and switches monitoring off the rate-limited public RPC.
- Optional `SOLANA_RPC_URL` — any other keyed RPC.

Dashboard password and cron secret live in `sol_settings` (key `secrets`), never in the repo.
Errors are redacted (`api-key=***`, `bot***`) before they are stored or shown.

## Tests

```bash
bun test sol-tracker/test
```
Covers swap classification (SOL, WSOL, USDC legs, transfers, non-signer fees, foreign token accounts) and the
research math (windows, average cost, airdrop exclusion, oversells, open positions, sniper detection, a passing wallet).

### Copy speed (2026-11-25)

Owner target: a copy lands within 1 to 2 s of the trader. Measured before this change (median of 40 paper
copies, Nov 24-25): Helius webhook arrives ~1 s after the trader's block, the function then re-read all
wallets over RPC (~1.5 s), waited the 2 s confirm-hold, and took ~0.8 s to quote and fill, about 5.5 s in all.
Now the webhook body itself is parsed and recorded at once (`fastPathFromWebhook`; the cursor run that
follows is the backup and dedupes), the market, filter and Jupiter quote lookups run in parallel, and the
config sets `copy.confirm_hold_seconds` and `paper.exec_delay_seconds` to 0. `delay_seconds` in the ledger
is now measured when the fill quote is in hand (was: when filling started). Trade-off: with no hold, a
trader's sub-second flip is copied instead of skipped (the 2 s hold skipped none of ~110 copies).

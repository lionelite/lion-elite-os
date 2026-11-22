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

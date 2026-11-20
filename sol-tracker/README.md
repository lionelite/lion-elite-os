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

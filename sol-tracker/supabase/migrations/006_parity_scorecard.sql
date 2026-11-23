-- Paper/live parity, realistic fills, trader scorecard (2026-11-23).

-- Paper positions remember the token's decimals so sells can be priced with a real Jupiter quote.
alter table public.sol_paper_positions add column if not exists decimals integer;

-- Live buys wait the shared confirm-hold before executing (fast-flip skip), like paper.
alter table public.sol_live_orders add column if not exists due_at timestamptz not null default now();
create index if not exists sol_live_orders_due on public.sol_live_orders (status, due_at);

-- Live positions get an effective entry price so the shared stop-loss / take-profit can run on them.
alter table public.sol_live_positions add column if not exists decimals integer;
alter table public.sol_live_positions add column if not exists token_raw text;
alter table public.sol_live_positions add column if not exists entry_price_usd numeric;
alter table public.sol_live_positions add column if not exists tp_taken boolean not null default false;

-- Scorecard: watch -> eligible -> live (owner approves in Telegram) | declined.
alter table public.sol_wallets add column if not exists stage text not null default 'watch';
alter table public.sol_wallets add column if not exists score jsonb;

-- One set of copy rules for paper and live, plus the live loss limit.
update public.sol_settings
   set value = value
     || jsonb_build_object('copy', jsonb_build_object(
          'buy_sol', coalesce((value->'live'->>'buy_sol')::numeric, 0.25),
          'confirm_hold_seconds', coalesce((value->'paper'->>'confirm_hold_seconds')::numeric, 60),
          'stop_loss_pct', coalesce((value->'paper'->>'stop_loss_pct')::numeric, 25),
          'take_profit_pct', coalesce((value->'paper'->>'take_profit_pct')::numeric, 50),
          'take_profit_sell_frac', coalesce((value->'paper'->>'take_profit_sell_frac')::numeric, 0.5),
          'max_open_positions', coalesce((value->'live'->>'max_open_positions')::numeric, 8)))
     || jsonb_build_object('live', coalesce(value->'live', '{}'::jsonb) || jsonb_build_object('max_loss_sol', 1.5))
 where key = 'config' and not (value ? 'copy');

-- Real money now requires a paper record plus owner approval. The six Kolscan wallets were set to
-- copy_live by hand on 2026-11-22 and lost money on paper; they go back to watch (they stay paused).
update public.sol_wallets set copy_live = false, stage = 'watch' where copy_live and stage <> 'live';

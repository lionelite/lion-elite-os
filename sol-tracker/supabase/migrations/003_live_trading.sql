-- Live copy trading (real money). RLS on, no policies: only the edge function's service role touches these.

-- Only wallets with copy_live = true are copied with real money; every other wallet is monitor-only.
alter table public.sol_wallets add column if not exists copy_live boolean not null default false;

create table if not exists public.sol_live_orders (
  id bigserial primary key,
  source_signature text not null,                 -- the copied trader's transaction (or a sell-all marker)
  wallet text not null,                           -- the copied trader
  mint text not null,
  symbol text,
  side text not null check (side in ('buy','sell')),
  trade jsonb,                                    -- the detected trade that caused this order
  status text not null default 'pending'
    check (status in ('pending','executing','sent','confirmed','failed','skipped')),
  sol_amount numeric,                             -- buy: SOL spent (reserved before send); sell: quoted SOL out
  token_amount text,                              -- raw units, as a string (u64 does not fit numeric safely in JS)
  close boolean not null default false,           -- sell: this order sells the whole position
  tx_signature text,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_signature, side)                 -- one order per copied trade: duplicates are impossible
);
create index if not exists sol_live_orders_status on public.sol_live_orders (status, created_at);

create table if not exists public.sol_live_positions (
  mint text primary key,                          -- at most one open copied position per token
  wallet text not null,                           -- the trader whose buy opened it; only their sells close it
  symbol text,
  sol_in numeric not null default 0,
  sol_out numeric not null default 0,             -- quoted SOL received from sells
  status text not null default 'open' check (status in ('open','closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

alter table public.sol_live_orders    enable row level security;
alter table public.sol_live_positions enable row level security;

-- Owner-chosen limits (2026-11-22): 0.25 SOL per copied buy, 5 SOL total. Nothing trades until the owner
-- adds the LIVE_TRADER_KEY Edge Function secret and funds that wallet.
update public.sol_settings
   set value = value || jsonb_build_object('live', jsonb_build_object(
     'enabled', true, 'buy_sol', 0.25, 'total_cap_sol', 5, 'max_open_positions', 8, 'slippage_bps', 1500,
     'min_sol_reserve', 0.03, 'min_liquidity_usd', 10000, 'max_buy_delay_seconds', 120,
     'skip_freeze_authority', true, 'min_trader_buy_sol', 0.25))
 where key = 'config' and not (value ? 'live');

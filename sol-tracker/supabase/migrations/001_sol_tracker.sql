-- Solana trader monitor schema (applied to the "Lion Elite OS Backend" Supabase project).
-- Monitoring + paper trading only. No keys, no signing, no live trades.
-- RLS is enabled on every table with NO policies: only the edge function (service role) reads/writes.

create table if not exists public.sol_settings (
  key text primary key,            -- 'config' | 'health' | 'secrets'
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sol_wallets (
  address text primary key,
  label text not null,
  status text not null default 'active',          -- active | paused | removed
  evidence jsonb not null default '{}'::jsonb,    -- why this wallet was selected, with sources + timestamps
  source text,
  added_at timestamptz not null default now(),
  last_signature text,                            -- monitoring cursor; survives restarts
  last_checked_at timestamptz,
  last_activity_at timestamptz,
  last_error text,
  consecutive_errors integer not null default 0,
  health_alerted boolean not null default false
);

create table if not exists public.sol_trades (
  signature text not null,
  wallet text not null,
  kind text not null,                             -- buy | sell | transfer_in | transfer_out | token_swap
  mint text, token_name text, token_symbol text,
  sol_value numeric, quote text, quote_amount numeric,
  token_amount numeric, token_pre numeric, token_post numeric,
  exit_type text, exit_pct numeric,               -- FULL | PARTIAL for sells
  block_time timestamptz, slot bigint,
  detected_at timestamptz not null default now(),
  market jsonb, risk jsonb,
  alert_status text not null default 'none',      -- none | pending | sent | failed | below_threshold | paused | expired
  alert_attempts integer not null default 0,
  alert_error text, alerted_at timestamptz, telegram_message_id bigint,
  primary key (signature, wallet)                 -- dedupe by transaction + wallet
);

create table if not exists public.sol_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  level text not null default 'info',
  kind text not null,
  wallet text,
  message text not null
);

create table if not exists public.sol_paper_positions (
  id bigserial primary key,
  wallet text not null, mint text not null, symbol text,
  opened_at timestamptz not null default now(),
  source_signature text not null,
  entry_price_usd numeric not null, qty numeric not null, cost_usd numeric not null,
  qty_open numeric not null, realized_usd numeric not null default 0,
  status text not null default 'open', closed_at timestamptz
);

create table if not exists public.sol_paper_ledger (
  id bigserial primary key,
  at timestamptz not null default now(),
  type text not null,                             -- buy | sell | skip | reset  (all SIMULATED)
  wallet text, mint text, symbol text,
  usd numeric, price_usd numeric, delay_seconds numeric,
  source_signature text, note text
);

create table if not exists public.sol_paper_orders (
  id bigserial primary key,
  signature text not null, wallet text not null,
  trade jsonb not null,
  due_at timestamptz not null,                    -- detection time + configured execution delay
  status text not null default 'queued' check (status in ('queued','filled','error','cancelled')),
  filled_at timestamptz, error text,
  created_at timestamptz not null default now(),
  unique (signature, wallet)
);
create index if not exists sol_paper_orders_due on public.sol_paper_orders (status, due_at);

alter table public.sol_settings        enable row level security;
alter table public.sol_wallets         enable row level security;
alter table public.sol_trades          enable row level security;
alter table public.sol_events          enable row level security;
alter table public.sol_paper_positions enable row level security;
alter table public.sol_paper_ledger    enable row level security;
alter table public.sol_paper_orders    enable row level security;

-- Default config (secrets row is created separately with random values; never commit them).
insert into public.sol_settings (key, value) values ('config', '{
  "min_buy_sol": 0.5, "alerts_paused": false, "telegram_chat_id": null,
  "paper": {"starting_usd": 250, "position_pct": 10, "max_position_usd": 25, "max_open_positions": 8,
            "slippage_pct": 3, "fee_pct": 1, "priority_fee_sol": 0.0015, "exec_delay_seconds": 30, "copy_sells": true}
}'::jsonb) on conflict (key) do nothing;

-- Every minute: pg_cron -> pg_net -> edge function /tick (authenticated with secrets.cron_secret).
-- select cron.schedule('sol-tracker-tick', '* * * * *', $$
--   select net.http_post(
--     url := 'https://<project-ref>.supabase.co/functions/v1/sol-tracker/tick',
--     headers := jsonb_build_object('content-type','application/json','x-cron-secret',
--                (select value->>'cron_secret' from public.sol_settings where key='secrets')),
--     body := '{}'::jsonb, timeout_milliseconds := 55000);
-- $$);

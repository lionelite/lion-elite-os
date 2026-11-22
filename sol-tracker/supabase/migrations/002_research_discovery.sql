-- Trader research + on-chain discovery tables. The first three statements record tables that were
-- created in the live project before they were written down here; they are no-ops there.
create table if not exists public.sol_research (
  wallet text primary key,
  label text not null,
  source text,
  source_snapshot jsonb,
  status text not null default 'queued' check (status in ('queued','collecting','parsing','done','error')),
  sig_cursor text,
  pages_fetched integer not null default 0,
  attempts integer not null default 0,
  metrics jsonb,
  error text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  capped boolean not null default false
);

create table if not exists public.sol_research_swaps (
  wallet text not null,
  signature text not null,
  block_time timestamptz,
  parsed boolean not null default false,
  kind text, mint text,
  sol_delta numeric, stable_delta numeric, token_delta numeric,
  primary key (wallet, signature)
);
create index if not exists sol_research_swaps_todo on public.sol_research_swaps (wallet, parsed);

create table if not exists public.sol_discovery_hits (
  wallet text not null,
  mint text not null,
  pool text,
  token text,
  sol_out numeric not null default 0,
  found_at timestamptz not null default now(),
  primary key (wallet, mint)
);

-- Round-trip evidence per (wallet, coin) from the pool scan, and the pre-filter's verdict on it.
alter table public.sol_discovery_hits add column if not exists sol_in numeric not null default 0;
alter table public.sol_discovery_hits add column if not exists buys integer not null default 0;
alter table public.sol_discovery_hits add column if not exists sells integer not null default 0;
alter table public.sol_discovery_hits add column if not exists verdict text; -- discoveryVerdict() reason; null = scanned before the filter existed
create index if not exists sol_discovery_hits_scan on public.sol_discovery_hits (verdict, found_at);

alter table public.sol_research       enable row level security;
alter table public.sol_research_swaps enable row level security;
alter table public.sol_discovery_hits enable row level security;

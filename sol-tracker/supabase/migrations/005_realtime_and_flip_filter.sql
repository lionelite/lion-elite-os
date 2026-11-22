-- Realtime trigger (Helius webhook) + fast-flip filter for paper buys.
-- A buy order can now end as 'skipped' (trader had already sold when we checked).
alter table public.sol_paper_orders drop constraint if exists sol_paper_orders_status_check;
alter table public.sol_paper_orders add constraint sol_paper_orders_status_check
  check (status in ('queued','filled','error','cancelled','skipped'));

-- Cross-instance lock: the minute cron and webhook-triggered runs never process at the same time.
create table if not exists public.sol_locks (name text primary key, until timestamptz not null);
alter table public.sol_locks enable row level security;
create or replace function public.sol_try_lock(lock_name text, ttl_seconds int)
returns boolean language sql security definer set search_path = public as $$
  insert into sol_locks(name, until) values (lock_name, now() + make_interval(secs => ttl_seconds))
  on conflict (name) do update set until = excluded.until where sol_locks.until < now()
  returning true
$$;
create or replace function public.sol_unlock(lock_name text)
returns void language sql security definer set search_path = public as $$
  update sol_locks set until = now() - interval '1 second' where name = lock_name
$$;
revoke all on function public.sol_try_lock(text, int) from public, anon, authenticated;
revoke all on function public.sol_unlock(text) from public, anon, authenticated;
grant execute on function public.sol_try_lock(text, int), public.sol_unlock(text) to service_role;

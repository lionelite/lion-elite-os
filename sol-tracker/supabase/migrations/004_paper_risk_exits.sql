-- Paper take-profit fires once per position.
alter table public.sol_paper_positions add column if not exists tp_taken boolean not null default false;

-- Traders List for Generic-mode trade-analyzer.html.
-- Funko/Topps modes keep using their existing funko.traders_list /
-- topps.traders_list tables untouched — this is only for collections
-- searched via Generic mode, where a wallet may be a trader on many
-- unrelated collections at once (unlike Funko/Topps, wallet can't be
-- the primary key here — the natural key is wallet + collection_name).
--
-- Run this once in the Supabase SQL Editor. Nothing in the app executes
-- DDL — Claude Code has no service-role/DB credentials, only the
-- anon key, so this step has to be run manually.

create table if not exists public.traders_list_generic (
  id              bigint generated always as identity primary key,
  wallet          text not null,
  collection_name text not null,
  description     text,
  featured        boolean not null default false,
  joined_at       timestamptz not null default now(),
  unique (wallet, collection_name)
);

alter table public.traders_list_generic enable row level security;

create policy "anon_select" on public.traders_list_generic
  for select to anon using (true);

-- Intentionally permissive, matching the existing funko.traders_list /
-- topps.traders_list write policies (see memory: supabase_security.md —
-- "write policies intentionally permissive, Security Advisor warnings
-- accepted"). There's no server-side wallet-ownership check anywhere in
-- this feature; trust boundary is unchanged from the existing tables.
create policy "anon_insert" on public.traders_list_generic
  for insert to anon with check (true);

create policy "anon_delete" on public.traders_list_generic
  for delete to anon using (true);

-- If INSERT/DELETE fail with a permission-denied error after the above
-- (some Supabase projects don't grant table-level privileges to anon by
-- default when a table is created via the SQL editor rather than the
-- dashboard table UI), also run:
-- grant select, insert, delete on public.traders_list_generic to anon;

-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query → paste → Run).
-- Creates a single shared record that all visitors' browsers read to know
-- the current fastest-to-slowest order of WAX API servers, refreshed at
-- most once every 6 hours by whichever visitor's browser happens to find
-- it stale.

create table if not exists public.wax_endpoint_health (
  id smallint primary key default 1,
  endpoint_order jsonb not null,
  checked_at timestamptz not null default now(),
  constraint wax_endpoint_health_singleton check (id = 1)
);

insert into public.wax_endpoint_health (id, endpoint_order, checked_at)
values (1, '[
  "https://wax.eosusa.io",
  "https://atomic.wax.eosrio.io",
  "https://wax.api.atomicassets.io",
  "https://wax-aa.eu.eosamsterdam.net",
  "https://atomic.hivebp.io",
  "https://aa.dapplica.io",
  "https://wax-atomic.alcor.exchange",
  "https://wax-atomic-api.eosphere.io",
  "https://atomic.sentnl.io",
  "https://atomic.wax.detroitledger.tech"
]'::jsonb, now())
on conflict (id) do nothing;

alter table public.wax_endpoint_health enable row level security;

drop policy if exists "wax_endpoint_health_anon_read" on public.wax_endpoint_health;
create policy "wax_endpoint_health_anon_read"
  on public.wax_endpoint_health
  for select
  to anon
  using (true);

-- Writes only ever go through this function, never a direct table update.
-- It silently does nothing if: the payload doesn't look like a plausible
-- list of HTTPS endpoint URLs, or the record isn't actually stale yet
-- (this is what makes it safe for any anonymous visitor to call — at most
-- one write per 6 hours actually takes effect, no matter how often or by
-- whom it's called).
create or replace function public.update_wax_endpoint_health(p_order jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_order) <> 'array'
     or jsonb_array_length(p_order) < 5
     or jsonb_array_length(p_order) > 15
     or exists (
       select 1 from jsonb_array_elements_text(p_order) v
       where v !~ '^https://[a-z0-9.-]+$'
     )
  then
    return;
  end if;

  update public.wax_endpoint_health
  set endpoint_order = p_order,
      checked_at = now()
  where id = 1
    and checked_at < now() - interval '6 hours';
end;
$$;

grant execute on function public.update_wax_endpoint_health(jsonb) to anon;

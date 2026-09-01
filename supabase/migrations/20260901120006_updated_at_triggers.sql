-- Phase 1: Database Foundation
--
-- Generic updated_at bookkeeping: every table that has an updated_at
-- column gets it refreshed to now() automatically on every row update, so
-- application code never has to set it by hand. Applied only to the
-- tables that actually have an updated_at column per DATABASE.md
-- (negotiation_messages, approvals, agent_sessions and audit_events do
-- not).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at before update on public.merchants
  for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.buyers
  for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.products
  for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.inventory
  for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.merchant_policies
  for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.rfqs
  for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.quotes
  for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create trigger set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

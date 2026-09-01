-- Phase 1: Database Foundation
--
-- Financial invariant (explicit Phase 1 requirement; not verbatim text in
-- DATABASE.md, which states the "multiple payment attempts, no
-- payment_id" half of this in section 14 / Core Data Integrity Rule 13):
--
--   1. An order may have multiple payment attempts.
--   2. At most one payment for an order may reach PAID status.
--   3. Once an order has a PAID payment, new payment creation attempts
--      for that order must be rejected.
--
-- (1) requires no extra constraint: payments carries no uniqueness on
-- order_id alone, so multiple rows per order are already allowed.

-- (2): a partial unique index enforces "at most one PAID row per
-- order_id" transactionally -- Postgres checks this the same way it
-- checks any unique index, so a second concurrent transaction trying to
-- mark a second payment PAID for the same order will block/fail against
-- the index rather than lose a race.
create unique index payments_one_paid_per_order_idx
  on public.payments (order_id)
  where status = 'PAID';

-- (3) is not covered by the index above: a *new* row with status CREATED
-- or PENDING does not violate a partial unique index scoped to
-- status = 'PAID', so a trigger is the safest mechanism Postgres offers
-- for rejecting new payment rows outright once a PAID payment already
-- exists for the order. It runs inside the same transaction as the
-- insert, so it holds even if application-level checks are buggy or
-- bypassed. Scope is deliberately limited to INSERT, matching "new
-- payment creation attempts" -- it does not attempt to govern status
-- transitions on rows that already existed before the order was paid,
-- which is an application-level concern for a later phase.
create or replace function public.reject_payment_if_order_already_paid()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.payments
    where order_id = new.order_id
      and status = 'PAID'
  ) then
    raise exception
      'order % already has a PAID payment; new payment attempts are rejected',
      new.order_id;
  end if;
  return new;
end;
$$;

create trigger payments_reject_if_order_paid
  before insert on public.payments
  for each row
  execute function public.reject_payment_if_order_already_paid();

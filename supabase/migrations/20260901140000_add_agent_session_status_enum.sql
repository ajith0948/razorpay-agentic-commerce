-- Schema clarification: agent_sessions.status allowed values
--
-- DATABASE.md section 15 lists "status" as a required Agent Session field
-- but, unlike rfq/quote/payment/order/approval, never enumerates its valid
-- values. Phase 1 (20260901120003_create_core_tables.sql) left the column
-- as unconstrained text pending that clarification. This migration closes
-- the gap with the four values now specified:
--   RUNNING, COMPLETED, FAILED, CANCELLED
--
-- Implemented as a Postgres enum, consistent with every other closed
-- state/value set already in the schema (rfq_status, quote_status,
-- payment_status, order_status, approval_status, agent_session_type,
-- audit_actor_type -- see 20260901120002_create_enums.sql).
create type public.agent_session_status as enum (
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

-- No default is introduced here: the column was NOT NULL with no default
-- before this migration, and this change is scoped to constraining the
-- existing text values to a closed enum, nothing more.
alter table public.agent_sessions
  alter column status type public.agent_session_status
  using status::public.agent_session_status;

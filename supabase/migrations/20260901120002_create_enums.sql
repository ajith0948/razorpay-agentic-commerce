-- Phase 1: Database Foundation
--
-- Enum types for the closed state-machine / value sets defined in
-- DATABASE.md. Each list below is copied verbatim from the section named
-- in its comment; nothing here is invented.

-- DATABASE.md section 9 "RFQ State Machine" -- full set of RFQ states.
create type public.rfq_status as enum (
  'CREATED',
  'PROCESSING',
  'QUOTED',
  'NEGOTIATING',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'FAILED'
);

-- DATABASE.md section 10 "Quote" -- quote status.
create type public.quote_status as enum (
  'DRAFT',
  'SENT',
  'NEGOTIATING',
  'ACCEPTED',
  'EXPIRED',
  'REJECTED'
);

-- DATABASE.md section 11 "Negotiation Message" -- sender_type.
create type public.negotiation_sender_type as enum (
  'BUYER',
  'SELLER_AGENT',
  'HUMAN_MERCHANT',
  'SYSTEM'
);

-- DATABASE.md section 12 "Approval" -- status.
create type public.approval_status as enum (
  'PENDING',
  'APPROVED',
  'REJECTED'
);

-- DATABASE.md section 13 "Payment" -- payment state.
create type public.payment_status as enum (
  'CREATED',
  'PENDING',
  'PAID',
  'FAILED'
);

-- DATABASE.md section 14 "Order" -- order status.
create type public.order_status as enum (
  'CREATED',
  'PAYMENT_PENDING',
  'PAID',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'CANCELLED'
);

-- DATABASE.md section 15 "Agent Session" -- session_type.
create type public.agent_session_type as enum (
  'SELLER_AGENT',
  'BUYER_AGENT'
);

-- DATABASE.md section 16 "Audit Event" -- actor_type. Distinct from
-- negotiation_sender_type above: this set additionally includes RAZORPAY.
create type public.audit_actor_type as enum (
  'BUYER',
  'SELLER_AGENT',
  'HUMAN_MERCHANT',
  'SYSTEM',
  'RAZORPAY'
);

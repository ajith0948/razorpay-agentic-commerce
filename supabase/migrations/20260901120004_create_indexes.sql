-- Phase 1: Database Foundation
--
-- Indexes for common lookup paths. Postgres does not automatically index
-- foreign key columns (unlike primary keys), so every foreign key gets a
-- plain index here; composite indexes are added where a status/scope
-- filter is clearly implied by the tool list (AGENTS.md section 7) and
-- the dashboards described in ARCHITECTURE.md (merchant-scoped status
-- listings, buyer-scoped history, audit trails).

-- buyers
create index buyers_merchant_id_idx on public.buyers (merchant_id);

-- products
create index products_merchant_id_idx on public.products (merchant_id);
create index products_merchant_active_idx on public.products (merchant_id, active);
create index products_category_idx on public.products (category);

-- inventory (product_id is already indexed via its unique constraint)

-- merchant_policies
create index merchant_policies_merchant_id_idx on public.merchant_policies (merchant_id);

-- rfqs
create index rfqs_merchant_id_idx on public.rfqs (merchant_id);
create index rfqs_buyer_id_idx on public.rfqs (buyer_id);
create index rfqs_merchant_status_idx on public.rfqs (merchant_id, status);

-- quotes
create index quotes_rfq_id_idx on public.quotes (rfq_id);
create index quotes_merchant_id_idx on public.quotes (merchant_id);
create index quotes_buyer_id_idx on public.quotes (buyer_id);
create index quotes_merchant_status_idx on public.quotes (merchant_id, status);

-- orders
create index orders_merchant_id_idx on public.orders (merchant_id);
create index orders_buyer_id_idx on public.orders (buyer_id);
create index orders_rfq_id_idx on public.orders (rfq_id);
create index orders_quote_id_idx on public.orders (quote_id);
create index orders_merchant_status_idx on public.orders (merchant_id, status);

-- payments (razorpay_order_id / razorpay_payment_link_id are already
-- indexed via their unique constraints; the partial unique index in the
-- payment-invariant migration covers PAID-filtered lookups but not
-- general order_id lookups, so order_id gets its own plain index too)
create index payments_order_id_idx on public.payments (order_id);
create index payments_quote_id_idx on public.payments (quote_id);

-- negotiation_messages
create index negotiation_messages_quote_id_idx on public.negotiation_messages (quote_id, created_at);

-- approvals
create index approvals_merchant_id_idx on public.approvals (merchant_id);
create index approvals_rfq_id_idx on public.approvals (rfq_id);
create index approvals_quote_id_idx on public.approvals (quote_id);
create index approvals_merchant_status_idx on public.approvals (merchant_id, status);

-- agent_sessions
create index agent_sessions_merchant_id_idx on public.agent_sessions (merchant_id);
create index agent_sessions_buyer_id_idx on public.agent_sessions (buyer_id);
create index agent_sessions_rfq_id_idx on public.agent_sessions (rfq_id);

-- audit_events
create index audit_events_merchant_created_idx on public.audit_events (merchant_id, created_at);
create index audit_events_rfq_id_idx on public.audit_events (rfq_id);
create index audit_events_order_id_idx on public.audit_events (order_id);
create index audit_events_agent_session_id_idx on public.audit_events (agent_session_id);

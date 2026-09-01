-- Phase 1: Database Foundation
--
-- Core tables from DATABASE.md section 2. Tables are created in FK
-- dependency order, which differs slightly from the doc's own numbered
-- list (Payment is listed before Order in section 2, but Payment.order_id
-- requires the orders table to exist first).
--
-- Conventions applied uniformly (see the Phase 1 report for the reasoning
-- behind each):
--   - Primary keys: uuid, default gen_random_uuid().
--   - Timestamps: timestamptz, not plain timestamp.
--   - Money: numeric(12,2). Percentages: numeric(5,2).
--   - Nullability: every field in an entity's "Fields:" list is NOT NULL
--     UNLESS (a) it is populated later in a documented lifecycle, (b)
--     DATABASE.md itself hedges it as optional ("may include"), or (c) it
--     is one of Audit Event's contextual foreign keys. Each nullable
--     column below has a comment explaining which case applies.
--   - ON DELETE: default (block deletion while references exist) for
--     every foreign key, protecting financial/audit history from
--     accidental loss, EXCEPT inventory.product_id (ON DELETE CASCADE,
--     since an inventory row is pure attribute data of its product with
--     no independent meaning) and Audit Event's contextual foreign keys
--     (ON DELETE SET NULL, so the permanent log entry survives even if
--     the thing it referenced is later removed).

-- ---------------------------------------------------------------------------
-- 3. Merchant
-- ---------------------------------------------------------------------------
create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  email text not null,
  phone text not null,
  currency text not null default 'INR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Buyer
-- ---------------------------------------------------------------------------
create table public.buyers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  business_name text not null,
  email text not null,
  phone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. Product
--
-- "attributes" holds the packaging attributes DATABASE.md section 5 lists
-- under "Additional packaging attributes may include" (length, width,
-- height, material, ply, printing_type) as a single nullable jsonb column
-- rather than dedicated columns, per the doc's own instruction that "the
-- schema should remain flexible enough to support other B2B product
-- categories later" -- dedicated packaging-specific columns would not
-- generalize to a different vertical.
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  name text not null,
  description text not null,
  category text not null,
  sku text not null,
  base_price numeric(12, 2) not null,
  currency text not null,
  minimum_quantity integer not null,
  active boolean not null default true,
  attributes jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_base_price_non_negative check (base_price >= 0),
  constraint products_minimum_quantity_positive check (minimum_quantity > 0),
  -- SKU is defined as an identifier for a product within a merchant's
  -- catalog; two products sharing a SKU under the same merchant would be
  -- a data integrity bug, not a legitimate state.
  constraint products_merchant_sku_key unique (merchant_id, sku)
);

-- ---------------------------------------------------------------------------
-- 6. Inventory
--
-- No created_at column: DATABASE.md section 6 lists only "updated_at" in
-- Inventory's Fields, unlike every other entity. Followed literally rather
-- than added for consistency, per "do not invent fields ... not specified".
--
-- available_quantity is read as the gross/total stock pool (what section
-- 6's formula calls "total available quantity"); the real-time sellable
-- amount is the derived value available_quantity - reserved_quantity. This
-- resolves an apparent naming overlap between the stored field and the
-- formula's "total available quantity" term.
-- ---------------------------------------------------------------------------
create table public.inventory (
  id uuid primary key default gen_random_uuid(),
  -- Cascades: an inventory row is pure attribute data of its product and
  -- has no independent meaning once the product is gone.
  product_id uuid not null unique references public.products (id) on delete cascade,
  available_quantity integer not null,
  reserved_quantity integer not null default 0,
  unit text not null,
  updated_at timestamptz not null default now(),
  constraint inventory_available_quantity_non_negative check (available_quantity >= 0),
  constraint inventory_reserved_quantity_non_negative check (reserved_quantity >= 0),
  -- "Available quantity must never become negative": the derived sellable
  -- amount (available_quantity - reserved_quantity) is kept non-negative
  -- by construction.
  constraint inventory_reserved_not_exceeding_available check (reserved_quantity <= available_quantity)
);

-- ---------------------------------------------------------------------------
-- 7. Merchant Policy
--
-- The four "Additional policy data may include" fields (section 7) are
-- each a list of allowed values, so they map naturally to nullable
-- Postgres array columns rather than a jsonb blob.
--
-- active mirrors a versioning pattern (a merchant may have historical
-- policy rows, with only one current at a time), so -- unlike
-- products.active, which has no such constraint -- a partial unique index
-- below enforces at most one active policy per merchant.
-- ---------------------------------------------------------------------------
create table public.merchant_policies (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  max_autonomous_order_value numeric(12, 2) not null,
  max_discount_percent numeric(5, 2) not null,
  minimum_margin_percent numeric(5, 2) not null,
  inventory_reservation_minutes integer not null,
  approval_required_above_amount numeric(12, 2) not null,
  active boolean not null default true,
  allowed_categories text[],
  allowed_delivery_regions text[],
  allowed_payment_methods text[],
  allowed_customer_types text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_policies_max_autonomous_order_value_non_negative check (max_autonomous_order_value >= 0),
  constraint merchant_policies_max_discount_percent_range check (max_discount_percent between 0 and 100),
  constraint merchant_policies_minimum_margin_percent_range check (minimum_margin_percent between 0 and 100),
  constraint merchant_policies_inventory_reservation_minutes_positive check (inventory_reservation_minutes > 0),
  constraint merchant_policies_approval_required_above_amount_non_negative check (approval_required_above_amount >= 0)
);

create unique index merchant_policies_one_active_per_merchant_idx
  on public.merchant_policies (merchant_id)
  where active;

-- ---------------------------------------------------------------------------
-- 8. RFQ
--
-- structured_requirements is nullable: it does not exist until the RFQ
-- moves from CREATED to PROCESSING and the parsing step (a later phase)
-- populates it. expires_at is nullable: not necessarily known at creation.
-- ---------------------------------------------------------------------------
create table public.rfqs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  buyer_id uuid not null references public.buyers (id),
  raw_request text not null,
  structured_requirements jsonb,
  status public.rfq_status not null default 'CREATED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 10. Quote
--
-- merchant_id/buyer_id are denormalized from rfq_id (every quote's
-- merchant/buyer already follow from its RFQ) but are kept as direct
-- columns because DATABASE.md section 10 lists them as explicit fields.
-- valid_until is nullable: not necessarily set while a quote is still
-- DRAFT.
-- ---------------------------------------------------------------------------
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.rfqs (id),
  merchant_id uuid not null references public.merchants (id),
  buyer_id uuid not null references public.buyers (id),
  total_amount numeric(12, 2) not null,
  currency text not null,
  discount_percent numeric(5, 2) not null default 0,
  delivery_days integer not null,
  delivery_location text not null,
  valid_until timestamptz,
  status public.quote_status not null default 'DRAFT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quotes_total_amount_non_negative check (total_amount >= 0),
  constraint quotes_discount_percent_range check (discount_percent between 0 and 100),
  constraint quotes_delivery_days_non_negative check (delivery_days >= 0)
);

-- ---------------------------------------------------------------------------
-- 14. Order
--
-- No payment_id column, by design (Phase 0 decision, restated in
-- DATABASE.md section 14): Payment.order_id is the only link between the
-- two tables, avoiding a circular foreign key and allowing multiple
-- payment attempts per order.
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  buyer_id uuid not null references public.buyers (id),
  rfq_id uuid not null references public.rfqs (id),
  quote_id uuid not null references public.quotes (id),
  total_amount numeric(12, 2) not null,
  currency text not null,
  status public.order_status not null default 'CREATED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_total_amount_non_negative check (total_amount >= 0)
);

-- ---------------------------------------------------------------------------
-- 13. Payment
--
-- razorpay_order_id / razorpay_payment_link_id are nullable: not known
-- until the backend actually calls Razorpay (a later phase), and only one
-- of the two is expected to be populated depending on which Razorpay flow
-- is used. Both are unique when present, so an external Razorpay
-- identifier never links to more than one internal payment row (Core Data
-- Integrity Rule 12). The "at most one PAID payment per order" and
-- "reject new attempts once an order is PAID" rules are implemented in
-- the payment-invariant migration, not here.
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id),
  quote_id uuid not null references public.quotes (id),
  razorpay_order_id text unique,
  razorpay_payment_link_id text unique,
  amount numeric(12, 2) not null,
  currency text not null,
  status public.payment_status not null default 'CREATED',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_amount_non_negative check (amount >= 0)
);

-- ---------------------------------------------------------------------------
-- 11. Negotiation Message
--
-- No updated_at column: an append-only log, matching "each negotiation
-- step should be preserved for auditability" (section 11). proposed_amount
-- / proposed_discount_percent are nullable: not every message proposes new
-- terms (e.g. a SYSTEM message logging context).
-- ---------------------------------------------------------------------------
create table public.negotiation_messages (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id),
  sender_type public.negotiation_sender_type not null,
  message text not null,
  proposed_amount numeric(12, 2),
  proposed_discount_percent numeric(5, 2),
  created_at timestamptz not null default now(),
  constraint negotiation_messages_proposed_amount_non_negative
    check (proposed_amount is null or proposed_amount >= 0),
  constraint negotiation_messages_proposed_discount_percent_range
    check (proposed_discount_percent is null or proposed_discount_percent between 0 and 100)
);

-- ---------------------------------------------------------------------------
-- 12. Approval
--
-- No updated_at column, per DATABASE.md section 12's field list.
-- approved_by is a nullable free-text field, not a foreign key: none of
-- DATABASE.md's 13 entities models an individual merchant-side human (only
-- Merchant, the business itself), and the MVP has no real authentication
-- (AGENTS.md section 10). Confirmed with the user for this phase. Nullable
-- along with approved_at because both are only populated once the
-- approval is resolved.
-- ---------------------------------------------------------------------------
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  rfq_id uuid not null references public.rfqs (id),
  quote_id uuid not null references public.quotes (id),
  requested_amount numeric(12, 2) not null,
  reason text not null,
  status public.approval_status not null default 'PENDING',
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint approvals_requested_amount_non_negative check (requested_amount >= 0)
);

-- ---------------------------------------------------------------------------
-- 15. Agent Session
--
-- started_at / ended_at serve as this entity's created_at / updated_at
-- equivalents, per DATABASE.md section 15's own field list (no separate
-- created_at/updated_at columns). ended_at is nullable until the session
-- ends.
--
-- status has no enumerated value list anywhere in DATABASE.md (unlike
-- rfq/quote/payment/order/approval, which all define one) and is
-- deliberately left as unconstrained text rather than an invented enum;
-- see the Phase 1 report.
-- ---------------------------------------------------------------------------
create table public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  buyer_id uuid not null references public.buyers (id),
  rfq_id uuid not null references public.rfqs (id),
  session_type public.agent_session_type not null,
  status text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

-- ---------------------------------------------------------------------------
-- 16. Audit Event
--
-- Only merchant_id is required; buyer_id/rfq_id/quote_id/order_id/
-- agent_session_id are nullable because a given event may not relate to
-- all of them (e.g. a policy-level event may have no rfq/quote/order yet)
-- and use ON DELETE SET NULL so the permanent log entry survives even if
-- the entity it referenced is later removed. event_type is free text, not
-- an enum: DATABASE.md section 16 presents its value list as "Examples:"
-- (illustrative), not a closed set like actor_type's "may include" list,
-- and is expected to grow as later phases add new tracked actions.
-- input_summary/output_summary/policy_result are nullable text: not every
-- event type produces all three, and their "summary" naming implies
-- human-readable prose rather than structured data.
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id),
  buyer_id uuid references public.buyers (id) on delete set null,
  rfq_id uuid references public.rfqs (id) on delete set null,
  quote_id uuid references public.quotes (id) on delete set null,
  order_id uuid references public.orders (id) on delete set null,
  agent_session_id uuid references public.agent_sessions (id) on delete set null,
  event_type text not null,
  actor_type public.audit_actor_type not null,
  action text not null,
  input_summary text,
  output_summary text,
  policy_result text,
  created_at timestamptz not null default now()
);

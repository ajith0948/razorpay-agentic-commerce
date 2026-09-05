-- supabase/seed.sql
--
-- Phase 3: Synthetic demo data for the custom-packaging B2B commerce demo
-- (see IMPLEMENTATION_PLAN.md section 6, "Phase 3 -- Seed Demo Data").
--
-- Scope: demo data only. This file creates rows in tables that already
-- exist (see the Phase 1 migrations) -- it does not create tables, types,
-- or any other schema object.
--
-- Idempotency: every insert targets a fixed, literal UUID (or, for
-- inventory, the product's fixed UUID via its unique product_id
-- constraint) and upserts with ON CONFLICT ... DO UPDATE. Re-running this
-- file -- via `supabase db reset`, or directly against an
-- already-seeded database -- updates the same rows in place and never
-- creates duplicate merchants, buyers, products, inventory rows, or
-- policies.
--
-- Synthetic data only: all business names are invented, every email uses
-- the IANA-reserved `.example` TLD (guaranteed not to resolve to a real
-- domain), and every phone number is a placeholder pattern. No real
-- person's data appears anywhere in this file.
--
-- How to run:
--   - Fresh local DB (applies migrations + this seed): `npx supabase db reset`
--   - Re-apply just this file against a running local DB:
--     `npx supabase db execute -f supabase/seed.sql` (or `psql "$DB_URL" -f supabase/seed.sql`)
-- See the "Local Database / Demo Seed Data" section in README.md.

begin;

-- ---------------------------------------------------------------------------
-- 1. Merchant -- ACME Packaging (DATABASE.md section 3's own example)
-- ---------------------------------------------------------------------------
insert into public.merchants (id, business_name, email, phone, currency)
values (
  '11111111-1111-1111-1111-111111111111',
  'ACME Packaging',
  'sales@acmepackaging.example',
  '+91-44-5550-0100',
  'INR'
)
on conflict (id) do update set
  business_name = excluded.business_name,
  email = excluded.email,
  phone = excluded.phone,
  currency = excluded.currency,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. Buyers -- 5 synthetic buyers, all belonging to ACME Packaging
-- ---------------------------------------------------------------------------
insert into public.buyers (id, merchant_id, business_name, email, phone)
values
  ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111111', 'ABC Textiles', 'procurement@abctextiles.example', '+91-44-5550-0201'),
  ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111111', 'FreshBox Retail', 'orders@freshboxretail.example', '+91-80-5550-0202'),
  ('22222222-2222-2222-2222-222222222203', '11111111-1111-1111-1111-111111111111', 'UrbanCart', 'purchasing@urbancart.example', '+91-80-5550-0203'),
  ('22222222-2222-2222-2222-222222222204', '11111111-1111-1111-1111-111111111111', 'Chennai Electronics', 'supplychain@chennaielectronics.example', '+91-44-5550-0204'),
  ('22222222-2222-2222-2222-222222222205', '11111111-1111-1111-1111-111111111111', 'South India Distributors', 'buying@southindiadist.example', '+91-40-5550-0205')
on conflict (id) do update set
  merchant_id = excluded.merchant_id,
  business_name = excluded.business_name,
  email = excluded.email,
  phone = excluded.phone,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. Products -- 14 packaging SKUs: 3-ply and 5-ply boxes in small/medium/
--    large, custom printed boxes (2-color and 4-color), corrugated
--    mailers, and one discontinued (active = false) box to exercise the
--    active flag. attributes follows the packaging shape DATABASE.md
--    section 5 lists under "Additional packaging attributes".
--
--    Product #6 (ACME-BOX-5PLY-L) intentionally matches the "5-Ply
--    Corrugated Box, 18x12x10, base price Rs.24" example used throughout
--    AGENTS.md / ARCHITECTURE.md / IMPLEMENTATION_PLAN.md, so that worked
--    examples elsewhere in the docs resolve against real seeded data.
-- ---------------------------------------------------------------------------
insert into public.products (id, merchant_id, name, description, category, sku, base_price, currency, minimum_quantity, active, attributes)
values
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111', '3-Ply Corrugated Box - Small', 'Lightweight 3-ply corrugated shipping box for small, low-weight items.', 'Corrugated Boxes', 'ACME-BOX-3PLY-S', 8.00, 'INR', 2000, true, '{"length":8,"width":6,"height":4,"unit_dimension":"in","material":"corrugated fiberboard","ply":3,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111111', '3-Ply Corrugated Box - Medium', 'Standard 3-ply corrugated box for general-purpose retail packaging.', 'Corrugated Boxes', 'ACME-BOX-3PLY-M', 14.00, 'INR', 1500, true, '{"length":12,"width":9,"height":6,"unit_dimension":"in","material":"corrugated fiberboard","ply":3,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333303', '11111111-1111-1111-1111-111111111111', '3-Ply Corrugated Box - Large', 'Large 3-ply corrugated box for bulky, lightweight goods.', 'Corrugated Boxes', 'ACME-BOX-3PLY-L', 19.00, 'INR', 1000, true, '{"length":18,"width":14,"height":10,"unit_dimension":"in","material":"corrugated fiberboard","ply":3,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333304', '11111111-1111-1111-1111-111111111111', '5-Ply Corrugated Box - Small', 'Heavy-duty 5-ply corrugated box for small items needing extra protection.', 'Corrugated Boxes', 'ACME-BOX-5PLY-S', 16.00, 'INR', 2000, true, '{"length":10,"width":8,"height":6,"unit_dimension":"in","material":"corrugated fiberboard","ply":5,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333305', '11111111-1111-1111-1111-111111111111', '5-Ply Corrugated Box - Medium', 'Heavy-duty 5-ply corrugated box for medium-weight goods.', 'Corrugated Boxes', 'ACME-BOX-5PLY-M', 20.00, 'INR', 1500, true, '{"length":14,"width":10,"height":8,"unit_dimension":"in","material":"corrugated fiberboard","ply":5,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333306', '11111111-1111-1111-1111-111111111111', '5-Ply Corrugated Box', 'Heavy-duty 5-ply corrugated box; the merchant''s flagship general-purpose shipping box.', 'Corrugated Boxes', 'ACME-BOX-5PLY-L', 24.00, 'INR', 1000, true, '{"length":18,"width":12,"height":10,"unit_dimension":"in","material":"corrugated fiberboard","ply":5,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333307', '11111111-1111-1111-1111-111111111111', '3-Ply Custom Printed Box - Small (2-Color)', 'Small 3-ply corrugated box with 2-color custom logo printing.', 'Custom Printed Boxes', 'ACME-BOX-3PLY-S-PRINT2', 11.00, 'INR', 1500, true, '{"length":8,"width":6,"height":4,"unit_dimension":"in","material":"corrugated fiberboard","ply":3,"printing_type":"2-color"}'),
  ('33333333-3333-3333-3333-333333333308', '11111111-1111-1111-1111-111111111111', '3-Ply Custom Printed Box - Medium (2-Color)', 'Medium 3-ply corrugated box with 2-color custom logo printing.', 'Custom Printed Boxes', 'ACME-BOX-3PLY-M-PRINT2', 18.00, 'INR', 1000, true, '{"length":12,"width":9,"height":6,"unit_dimension":"in","material":"corrugated fiberboard","ply":3,"printing_type":"2-color"}'),
  ('33333333-3333-3333-3333-333333333309', '11111111-1111-1111-1111-111111111111', '5-Ply Custom Printed Box - Medium (2-Color)', 'Medium 5-ply corrugated box with 2-color custom logo printing.', 'Custom Printed Boxes', 'ACME-BOX-5PLY-M-PRINT2', 25.00, 'INR', 1000, true, '{"length":14,"width":10,"height":8,"unit_dimension":"in","material":"corrugated fiberboard","ply":5,"printing_type":"2-color"}'),
  ('33333333-3333-3333-3333-333333333310', '11111111-1111-1111-1111-111111111111', '5-Ply Custom Printed Box - Large (4-Color)', 'Large 5-ply corrugated box with premium 4-color custom printing.', 'Custom Printed Boxes', 'ACME-BOX-5PLY-L-PRINT4', 32.00, 'INR', 500, true, '{"length":18,"width":12,"height":10,"unit_dimension":"in","material":"corrugated fiberboard","ply":5,"printing_type":"4-color"}'),
  ('33333333-3333-3333-3333-333333333311', '11111111-1111-1111-1111-111111111111', 'Corrugated Mailer - Small', 'Small self-sealing corrugated mailer for e-commerce shipping.', 'Mailers', 'ACME-MAILER-S', 6.00, 'INR', 3000, true, '{"length":9,"width":6,"height":2,"unit_dimension":"in","material":"corrugated kraft","ply":3,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333312', '11111111-1111-1111-1111-111111111111', 'Corrugated Mailer - Medium', 'Medium self-sealing corrugated mailer for e-commerce shipping.', 'Mailers', 'ACME-MAILER-M', 9.00, 'INR', 2000, true, '{"length":12,"width":9,"height":3,"unit_dimension":"in","material":"corrugated kraft","ply":3,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333313', '11111111-1111-1111-1111-111111111111', 'Corrugated Mailer - Large', 'Large self-sealing corrugated mailer for bulkier e-commerce items.', 'Mailers', 'ACME-MAILER-L', 13.00, 'INR', 1500, true, '{"length":15,"width":12,"height":4,"unit_dimension":"in","material":"corrugated kraft","ply":3,"printing_type":"none"}'),
  ('33333333-3333-3333-3333-333333333314', '11111111-1111-1111-1111-111111111111', '3-Ply Corrugated Box - Extra Large (Discontinued)', 'Legacy extra-large 3-ply box, discontinued and no longer sold.', 'Corrugated Boxes', 'ACME-BOX-3PLY-XL', 22.00, 'INR', 1000, false, '{"length":24,"width":18,"height":14,"unit_dimension":"in","material":"corrugated fiberboard","ply":3,"printing_type":"none"}')
on conflict (id) do update set
  merchant_id = excluded.merchant_id,
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  sku = excluded.sku,
  base_price = excluded.base_price,
  currency = excluded.currency,
  minimum_quantity = excluded.minimum_quantity,
  active = excluded.active,
  attributes = excluded.attributes,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 4. Inventory -- one row per ACTIVE product only (the discontinued
--    product, #14 above, deliberately has no inventory row). Quantities
--    are chosen so that a typical bulk demo RFQ (thousands of units, per
--    the canonical example in AGENTS.md/ARCHITECTURE.md) resolves as
--    AVAILABLE against most products and INSUFFICIENT_INVENTORY against
--    the two deliberately low-stock ones, mirroring the worked example in
--    ARCHITECTURE.md section 18. Product #6's own quantities (8000
--    available / 500 reserved) match that section's example exactly.
-- ---------------------------------------------------------------------------
insert into public.inventory (product_id, available_quantity, reserved_quantity, unit)
values
  ('33333333-3333-3333-3333-333333333301', 15000, 0, 'units'),
  ('33333333-3333-3333-3333-333333333302', 9000, 0, 'units'),
  ('33333333-3333-3333-3333-333333333303', 5000, 0, 'units'),
  ('33333333-3333-3333-3333-333333333304', 12000, 0, 'units'),
  ('33333333-3333-3333-3333-333333333305', 10000, 500, 'units'),
  ('33333333-3333-3333-3333-333333333306', 8000, 500, 'units'),
  ('33333333-3333-3333-3333-333333333307', 4000, 0, 'units'),
  ('33333333-3333-3333-3333-333333333308', 2500, 0, 'units'),
  ('33333333-3333-3333-3333-333333333309', 1800, 200, 'units'),
  ('33333333-3333-3333-3333-333333333310', 350, 0, 'units'),
  ('33333333-3333-3333-3333-333333333311', 25000, 0, 'units'),
  ('33333333-3333-3333-3333-333333333312', 18000, 0, 'units'),
  ('33333333-3333-3333-3333-333333333313', 600, 0, 'units')
on conflict (product_id) do update set
  available_quantity = excluded.available_quantity,
  reserved_quantity = excluded.reserved_quantity,
  unit = excluded.unit,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 5. Merchant Policy -- one active policy. Values are taken verbatim from
--    ARCHITECTURE.md section 9's own worked Policy Engine example, per
--    the task instruction to use the policy values already defined in
--    DATABASE.md / ARCHITECTURE.md. approval_required_above_amount is set
--    equal to max_autonomous_order_value: section 12's Approval Engine
--    example (quote Rs.114,000 vs. autonomous limit Rs.100,000 => APPROVAL
--    REQUIRED) ties approval to crossing that same autonomous ceiling,
--    and no other threshold value is specified anywhere in the docs.
--
--    allowed_delivery_regions is also where "delivery data" lives for
--    this phase: DATABASE.md has no separate delivery/region table (a
--    dedicated "Delivery Rule" entity is explicitly listed under section
--    21 "Future Extensions", not required for the MVP), so Chennai /
--    Bangalore / Hyderabad support is recorded here, on the existing
--    schema, rather than by inventing a new table.
--
--    allowed_payment_methods and allowed_customer_types are left NULL:
--    no concrete values for either are specified anywhere in AGENTS.md,
--    DATABASE.md, or ARCHITECTURE.md, and both columns are nullable for
--    exactly this reason.
-- ---------------------------------------------------------------------------
insert into public.merchant_policies (
  id, merchant_id, max_autonomous_order_value, max_discount_percent,
  minimum_margin_percent, inventory_reservation_minutes,
  approval_required_above_amount, active, allowed_categories,
  allowed_delivery_regions
)
values (
  '44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  100000.00,
  5.00,
  12.00,
  30,
  100000.00,
  true,
  array['Corrugated Boxes', 'Custom Printed Boxes', 'Mailers'],
  array['Chennai', 'Bangalore', 'Hyderabad']
)
on conflict (id) do update set
  merchant_id = excluded.merchant_id,
  max_autonomous_order_value = excluded.max_autonomous_order_value,
  max_discount_percent = excluded.max_discount_percent,
  minimum_margin_percent = excluded.minimum_margin_percent,
  inventory_reservation_minutes = excluded.inventory_reservation_minutes,
  approval_required_above_amount = excluded.approval_required_above_amount,
  active = excluded.active,
  allowed_categories = excluded.allowed_categories,
  allowed_delivery_regions = excluded.allowed_delivery_regions,
  updated_at = now();

commit;

/**
 * The Policy application layer's own narrow data-access port -- mirrors
 * lib/order/db.ts's pattern. A single read: this layer only ever needs "the
 * merchant's one active policy row" (the partial unique index in
 * supabase/migrations/20260901120003_create_core_tables.sql guarantees at
 * most one `active = true` row per merchant_id, so this is a lookup, not a
 * list).
 *
 * PostgrestResult is reused from lib/state-machine rather than redeclared,
 * same as every other layer's db.ts.
 */

import type { PostgrestResult } from "../state-machine/index.ts";

/**
 * The raw merchant_policies row shape, snake_case, exactly as
 * Postgres/PostgREST returns it. Field list matches DATABASE.md section 7
 * exactly, including the four nullable "additional policy data" array
 * columns.
 */
export interface MerchantPolicyRow {
  id: string;
  merchant_id: string;
  max_autonomous_order_value: number;
  max_discount_percent: number;
  minimum_margin_percent: number;
  inventory_reservation_minutes: number;
  approval_required_above_amount: number;
  active: boolean;
  allowed_categories: string[] | null;
  allowed_delivery_regions: string[] | null;
  allowed_payment_methods: string[] | null;
  allowed_customer_types: string[] | null;
  created_at: string;
  updated_at: string;
}

/**
 * The only database operation the Policy application layer needs. A test
 * fake can implement this in a few lines without modelling Supabase's full
 * chainable builder, mirroring every other layer's XDbClient.
 */
export interface PolicyDbClient {
  /**
   * Reads the merchant's one active policy row. `data: null` (with
   * `error: null`) means "no active policy configured for this merchant" --
   * a legitimate result, not an error (see errors.ts's doc comment).
   */
  getActiveMerchantPolicy(merchantId: string): PromiseLike<PostgrestResult<MerchantPolicyRow>>;
}

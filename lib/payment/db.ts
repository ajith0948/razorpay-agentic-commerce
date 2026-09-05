/**
 * The Payment application layer's own narrow data-access port -- mirrors
 * lib/order/db.ts's pattern exactly. Deliberately not lib/state-machine's
 * StatusDbClient (same reasoning as lib/order/db.ts's own doc comment:
 * that interface's insert() returns no row back, which createPayment()
 * needs).
 *
 * This module also does NOT depend on lib/order at all, by design:
 * createPayment() needs to read a handful of fields off the referenced
 * Order (its existence, quote_id/total_amount/currency, and status) --
 * pulling in the whole OrderApplication (which itself carries an
 * OrderDbClient and a StateRuntime dependency, neither of which this layer
 * needs) just to perform one narrow read would be a heavier, more indirect
 * dependency than reading those columns directly. This mirrors exactly how
 * lib/order/db.ts reads quotes directly rather than depending on
 * lib/quote, which in turn mirrors lib/quote/db.ts reading rfqs directly.
 *
 * PostgrestResult is reused from lib/state-machine rather than redeclared,
 * same as lib/order/db.ts and lib/quote/db.ts.
 */

import type { OrderStatus, PaymentStatus, PostgrestResult } from "../state-machine/index.ts";

/** The raw payments row shape, snake_case, exactly as Postgres/PostgREST returns it. */
export interface PaymentRow {
  id: string;
  order_id: string;
  quote_id: string;
  razorpay_order_id: string | null;
  razorpay_payment_link_id: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Columns createPayment() may set on insert. No `status`: the column's own
 * `default 'CREATED'` establishes the initial state, exactly like
 * lib/order/db.ts's NewOrderRow omits `status` for CREATED.
 */
export interface NewPaymentRow {
  order_id: string;
  quote_id: string;
  amount: number;
  currency: string;
  razorpay_order_id?: string | null;
  razorpay_payment_link_id?: string | null;
}

/**
 * The minimal Order fields createPayment() needs to validate the reference
 * and derive quote_id/amount/currency -- not lib/order's own Order type
 * (which also carries merchant_id/buyer_id/rfq_id this layer never uses).
 */
export interface OrderRefRow {
  id: string;
  quote_id: string;
  total_amount: number;
  currency: string;
  status: OrderStatus;
}

/**
 * The only database operations the Payment application layer needs. Narrow
 * and purpose-built, mirroring OrderDbClient: a test fake can implement
 * this in a few lines without modelling Supabase's full chainable builder.
 */
export interface PaymentDbClient {
  /** Inserts one payments row and returns it as the database actually stored it. */
  insertPayment(row: NewPaymentRow): PromiseLike<PostgrestResult<PaymentRow>>;
  /** Reads one payments row by id. `data: null` (with `error: null`) means "no such row". */
  getPaymentById(id: string): PromiseLike<PostgrestResult<PaymentRow>>;
  /** Reads the minimal Order fields needed to validate a createPayment() reference. */
  getOrderRef(orderId: string): PromiseLike<PostgrestResult<OrderRefRow>>;
}

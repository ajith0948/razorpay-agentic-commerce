/**
 * The Order application layer's own narrow data-access port -- mirrors
 * lib/quote/db.ts's pattern exactly. Deliberately not lib/state-machine's
 * StatusDbClient (same reasoning as lib/quote/db.ts's own doc comment: that
 * interface's insert() returns no row back, which createOrder() needs).
 *
 * This module also does NOT depend on lib/quote at all, by design:
 * createOrder() needs to read a handful of fields off the referenced Quote
 * (its existence, merchant_id/buyer_id/rfq_id/total_amount/currency, and
 * status) -- pulling in the whole QuoteApplication (which itself carries a
 * QuoteDbClient and a StateRuntime dependency, neither of which this layer
 * needs) just to perform one narrow read would be a heavier, more indirect
 * dependency than reading those columns directly, and would blur which
 * module owns the read. This mirrors exactly how lib/quote/db.ts reads
 * rfqs directly rather than depending on lib/rfq.
 *
 * PostgrestResult is reused from lib/state-machine rather than redeclared,
 * same as lib/quote/db.ts.
 *
 * NOTE on getOrderByQuoteId(): supabase/migrations/20260901120003_create_
 * core_tables.sql places no unique constraint on orders.quote_id, so this
 * is a plain (non-atomic) existence check createOrder() uses to enforce
 * DATABASE.md section 18 Core Data Integrity Rule 11 ("Duplicate financial
 * events must not create duplicate...orders") at the application layer --
 * see errors.ts's doc comment on OrderAlreadyExistsError for the race
 * condition this does NOT close, reported rather than silently patched
 * with an unrequested migration.
 */

import type { OrderStatus, PostgrestResult, QuoteStatus } from "../state-machine/index.ts";

/** The raw orders row shape, snake_case, exactly as Postgres/PostgREST returns it. */
export interface OrderRow {
  id: string;
  merchant_id: string;
  buyer_id: string;
  rfq_id: string;
  quote_id: string;
  total_amount: number;
  currency: string;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Columns createOrder() may set on insert. No `status`: the column's own
 * `default 'CREATED'` establishes the initial state, exactly like
 * lib/quote/db.ts's NewQuoteRow omits `status` for DRAFT.
 */
export interface NewOrderRow {
  merchant_id: string;
  buyer_id: string;
  rfq_id: string;
  quote_id: string;
  total_amount: number;
  currency: string;
}

/**
 * The minimal Quote fields createOrder() needs to validate the reference
 * and derive merchant_id/buyer_id/rfq_id/total_amount/currency -- not
 * lib/quote's own Quote type (which also carries
 * discountPercent/deliveryDays/deliveryLocation/validUntil this layer never
 * uses).
 */
export interface QuoteRefRow {
  id: string;
  merchant_id: string;
  buyer_id: string;
  rfq_id: string;
  total_amount: number;
  currency: string;
  status: QuoteStatus;
}

/**
 * The only database operations the Order application layer needs. Narrow
 * and purpose-built, mirroring QuoteDbClient: a test fake can implement
 * this in a few lines without modelling Supabase's full chainable builder.
 */
export interface OrderDbClient {
  /** Inserts one orders row and returns it as the database actually stored it. */
  insertOrder(row: NewOrderRow): PromiseLike<PostgrestResult<OrderRow>>;
  /** Reads one orders row by id. `data: null` (with `error: null`) means "no such row". */
  getOrderById(id: string): PromiseLike<PostgrestResult<OrderRow>>;
  /** Reads the minimal Quote fields needed to validate a createOrder() reference. */
  getQuoteRef(quoteId: string): PromiseLike<PostgrestResult<QuoteRefRow>>;
  /** Reads any existing Order for a given quote_id, for the duplicate-guard check. */
  getOrderByQuoteId(quoteId: string): PromiseLike<PostgrestResult<OrderRow>>;
}

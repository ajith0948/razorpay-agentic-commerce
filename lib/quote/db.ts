/**
 * The Quote application layer's own narrow data-access port -- mirrors
 * lib/rfq/db.ts's pattern exactly. Deliberately not lib/state-machine's
 * StatusDbClient (same reasoning as lib/rfq/db.ts's own doc comment: that
 * interface's insert() returns no row back, which createQuote() needs).
 *
 * This module also does NOT depend on lib/rfq at all, by design: createQuote()
 * needs to read a handful of fields off the referenced RFQ (its existence,
 * merchant_id/buyer_id, and status) and a handful of fields off the
 * merchant's active policy (max_discount_percent) -- pulling in the whole
 * RfqApplication (which itself carries a RequirementsParser and a
 * StateRuntime dependency, neither of which this layer needs) just to
 * perform two narrow reads would be a heavier, more indirect dependency
 * than reading those columns directly, and would blur which module owns
 * the read. Reading the same tables through a second, purpose-built port is
 * consistent with how lib/rfq/db.ts and lib/runtime/supabase-status-db.ts
 * already both read/write the same underlying rows for RFQ, each through
 * its own narrow interface.
 *
 * PostgrestResult is reused from lib/state-machine rather than redeclared,
 * same as lib/rfq/db.ts.
 */

import type { PostgrestResult, QuoteStatus, RfqStatus } from "../state-machine/index.ts";

/** The raw quotes row shape, snake_case, exactly as Postgres/PostgREST returns it. */
export interface QuoteRow {
  id: string;
  rfq_id: string;
  merchant_id: string;
  buyer_id: string;
  total_amount: number;
  currency: string;
  discount_percent: number;
  delivery_days: number;
  delivery_location: string;
  valid_until: string | null;
  status: QuoteStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Columns createQuote() may set on insert. No `status`: the column's own
 * `default 'DRAFT'` establishes the initial state, exactly like
 * lib/rfq/db.ts's NewRfqRow omits `status` for CREATED.
 */
export interface NewQuoteRow {
  rfq_id: string;
  merchant_id: string;
  buyer_id: string;
  total_amount: number;
  currency: string;
  discount_percent: number;
  delivery_days: number;
  delivery_location: string;
  valid_until?: string | null;
}

/**
 * The minimal RFQ fields createQuote() needs to validate the reference and
 * derive merchant_id/buyer_id -- not lib/rfq's own RfqRow (which also
 * carries raw_request/structured_requirements/timestamps this layer never
 * uses).
 */
export interface RfqRefRow {
  id: string;
  merchant_id: string;
  buyer_id: string;
  status: RfqStatus;
}

/**
 * The one merchant_policies field createQuote() needs (see policy.ts). Not
 * the full merchant_policies row -- this layer has no use for
 * max_autonomous_order_value, minimum_margin_percent, or any of the other
 * columns the future policy engine will own.
 */
export interface MerchantPolicyRow {
  max_discount_percent: number;
}

/**
 * The only database operations the Quote application layer needs. Narrow
 * and purpose-built, mirroring RfqDbClient: a test fake can implement this
 * in a few lines without modelling Supabase's full chainable builder.
 */
export interface QuoteDbClient {
  /** Inserts one quotes row and returns it as the database actually stored it. */
  insertQuote(row: NewQuoteRow): PromiseLike<PostgrestResult<QuoteRow>>;
  /** Reads one quotes row by id. `data: null` (with `error: null`) means "no such row". */
  getQuoteById(id: string): PromiseLike<PostgrestResult<QuoteRow>>;
  /** Reads the minimal RFQ fields needed to validate a createQuote() reference. */
  getRfqRef(rfqId: string): PromiseLike<PostgrestResult<RfqRefRow>>;
  /** Reads the merchant's one active policy row, if any (`data: null` means none configured). */
  getActiveMerchantPolicy(merchantId: string): PromiseLike<PostgrestResult<MerchantPolicyRow>>;
}

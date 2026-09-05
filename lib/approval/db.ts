/**
 * The Approval application layer's own narrow data-access port -- mirrors
 * lib/order/db.ts's pattern exactly, including not depending on lib/quote
 * (this layer reads the handful of Quote fields it needs -- id, merchant_id,
 * rfq_id, total_amount -- directly, for the same reason lib/order/db.ts's
 * doc comment gives: pulling in the whole QuoteApplication for one narrow
 * read would be a heavier, more indirect dependency).
 *
 * PostgrestResult is reused from lib/state-machine rather than redeclared,
 * same as every other layer's db.ts.
 */

import type { ApprovalStatus, PostgrestResult } from "../state-machine/index.ts";

/** The raw approvals row shape, snake_case, exactly as Postgres/PostgREST returns it. */
export interface ApprovalRow {
  id: string;
  merchant_id: string;
  rfq_id: string;
  quote_id: string;
  requested_amount: number;
  reason: string;
  status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

/**
 * Columns createApproval() may set on insert. No `status`: the column's own
 * `default 'PENDING'` establishes the initial state, exactly like
 * lib/order/db.ts's NewOrderRow omits `status` for CREATED. No
 * `approved_by`/`approved_at`: those are populated only by
 * transitionApproval() (lib/state-machine/approval.ts), when a human
 * actually resolves the approval.
 */
export interface NewApprovalRow {
  merchant_id: string;
  rfq_id: string;
  quote_id: string;
  requested_amount: number;
  reason: string;
}

/**
 * The minimal Quote fields createApproval() needs to validate the reference
 * and derive merchant_id/rfq_id/requested_amount -- not lib/quote's own
 * Quote type, mirroring lib/order/db.ts's QuoteRefRow.
 */
export interface QuoteRefRow {
  id: string;
  merchant_id: string;
  rfq_id: string;
  total_amount: number;
}

/**
 * The only database operations the Approval application layer needs.
 * Narrow and purpose-built, mirroring OrderDbClient.
 */
export interface ApprovalDbClient {
  /** Inserts one approvals row and returns it as the database actually stored it. */
  insertApproval(row: NewApprovalRow): PromiseLike<PostgrestResult<ApprovalRow>>;
  /** Reads one approvals row by id. `data: null` (with `error: null`) means "no such row". */
  getApprovalById(id: string): PromiseLike<PostgrestResult<ApprovalRow>>;
  /** Reads the minimal Quote fields needed to validate a createApproval() reference. */
  getQuoteRef(quoteId: string): PromiseLike<PostgrestResult<QuoteRefRow>>;
  /**
   * Reads the most recently created approvals row for a given quote_id (no
   * uniqueness constraint exists on this column -- see errors.ts's doc
   * comment on why no duplicate-guard error class was added here). Used by
   * the Agent tool layer to avoid creating a redundant PENDING row, and to
   * find an already-resolved approval to honor.
   */
  getLatestApprovalByQuoteId(quoteId: string): PromiseLike<PostgrestResult<ApprovalRow>>;
}

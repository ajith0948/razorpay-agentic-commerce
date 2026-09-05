/**
 * The RFQ application layer's own narrow data-access port -- the "data
 * access boundary" the Phase 4 spec asks for. Deliberately not
 * lib/state-machine's StatusDbClient: that interface's insert() always
 * returns `{data: null}` (db.ts (lib/state-machine): "Return types use
 * PromiseLike ... " -- StatusDbTableClient.insert -> PostgrestResult<null>),
 * which is enough for an audit-event write but not for RFQ creation, which
 * needs the inserted row back (its generated id, created_at, and the
 * schema-defaulted status). Rather than widen StatusDbClient (and risk
 * every lib/state-machine caller now depending on a shape it doesn't need),
 * this module defines its own two-operation port.
 *
 * PostgrestResult is reused from lib/state-machine rather than redeclared
 * here -- same {data, error} shape, no reason for a second definition.
 */

import type { PostgrestResult, RfqStatus } from "../state-machine/index.ts";

/** The raw rfqs row shape, snake_case, exactly as Postgres/PostgREST returns it. */
export interface RfqRow {
  id: string;
  merchant_id: string;
  buyer_id: string;
  raw_request: string;
  structured_requirements: Record<string, unknown> | null;
  status: RfqStatus;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

/**
 * Columns createRfq() may set on insert. No `status`: the column's own
 * `default 'CREATED'` (supabase/migrations/20260901120003_create_core_tables.sql)
 * establishes the initial state, per Step 3's instruction to preserve that
 * design rather than having application code set it explicitly.
 */
export interface NewRfqRow {
  merchant_id: string;
  buyer_id: string;
  raw_request: string;
  expires_at?: string | null;
}

/**
 * The only two database operations the RFQ application layer needs.
 * Narrow and purpose-built (not a generic query-builder facade) so a test
 * fake can implement it in a few lines (see application.test.ts) without
 * modelling Supabase's full chainable builder.
 */
export interface RfqDbClient {
  /** Inserts one rfqs row and returns it as the database actually stored it. */
  insertRfq(row: NewRfqRow): PromiseLike<PostgrestResult<RfqRow>>;
  /** Reads one rfqs row by id. `data: null` (with `error: null`) means "no such row", not a failure. */
  getRfqById(id: string): PromiseLike<PostgrestResult<RfqRow>>;
}

/**
 * The RFQ application layer's own public domain types -- distinct from the
 * raw database row shape (RfqRow, db.ts), which stays internal to this
 * module. `RfqStatus` itself is imported from lib/state-machine, not
 * redeclared, so the Postgres enum -> TypeScript union mapping continues to
 * have exactly one source of truth.
 */

import type { RfqStatus } from "../state-machine/index.ts";

/**
 * The public representation of an RFQ this layer returns to its callers.
 * camelCase, and free of any Supabase/PostgREST response envelope --
 * satisfies "avoid exposing unnecessary raw Supabase implementation
 * details" (Phase 4 spec, Step 4).
 */
export interface Rfq {
  id: string;
  merchantId: string;
  buyerId: string;
  rawRequest: string;
  structuredRequirements: Record<string, unknown> | null;
  status: RfqStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

/**
 * Input to createRfq(). Only the fields DATABASE.md section 8 actually
 * requires at creation time: merchant_id/buyer_id/raw_request are NOT NULL
 * with no default; expires_at is optional (nullable, "not necessarily
 * known at creation" per the schema's own comment). `status` is
 * deliberately absent -- it is not caller input, it is always the schema's
 * own 'CREATED' default (see application.ts's doc comment on createRfq()).
 * `structuredRequirements` is also absent: DATABASE.md section 8 populates
 * it only once the RFQ moves to PROCESSING, via a parsing step this phase
 * does not build.
 */
export interface CreateRfqInput {
  merchantId: string;
  buyerId: string;
  rawRequest: string;
  expiresAt?: string | null;
}

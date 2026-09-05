/**
 * The Quote application layer's own public domain types -- distinct from
 * the raw database row shape (QuoteRow, db.ts), which stays internal to
 * this module. `QuoteStatus` itself is imported from lib/state-machine, not
 * redeclared, so the Postgres enum -> TypeScript union mapping continues to
 * have exactly one source of truth (same pattern as lib/rfq/types.ts).
 */

import type { QuoteStatus } from "../state-machine/index.ts";

/**
 * The public representation of a Quote this layer returns to its callers.
 * camelCase, free of any Supabase/PostgREST response envelope. Field list
 * matches DATABASE.md section 10 exactly -- no invented columns (no
 * subtotal/tax/margin/unit price: the schema doesn't define them, and the
 * full Quote Engine that would compute them is out of scope for this
 * phase).
 */
export interface Quote {
  id: string;
  rfqId: string;
  merchantId: string;
  buyerId: string;
  totalAmount: number;
  currency: string;
  discountPercent: number;
  deliveryDays: number;
  deliveryLocation: string;
  validUntil: string | null;
  status: QuoteStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input to createQuote(). `merchantId`/`buyerId` are deliberately absent:
 * the quotes table's own migration comment describes them as "denormalized
 * from rfq_id (every quote's merchant/buyer already follow from its RFQ)",
 * so this layer derives them from the referenced RFQ row itself rather than
 * trusting separate caller-supplied values that could disagree with it.
 * `status` is also absent, for the same reason it is absent from
 * CreateRfqInput -- it is never caller input, only the schema's own
 * `status default 'DRAFT'`. `discountPercent` is optional, defaulting to 0
 * (the same value the column itself defaults to) so the policy check in
 * application.ts always has a concrete number to validate.
 */
export interface CreateQuoteInput {
  rfqId: string;
  totalAmount: number;
  currency: string;
  discountPercent?: number;
  deliveryDays: number;
  deliveryLocation: string;
  validUntil?: string | null;
}

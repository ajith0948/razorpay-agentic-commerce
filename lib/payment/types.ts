/**
 * The Payment application layer's own public domain types -- distinct from
 * the raw database row shape (PaymentRow, db.ts), which stays internal to
 * this module. `PaymentStatus` itself is imported from lib/state-machine,
 * not redeclared (same pattern as lib/quote/types.ts and lib/order/types.ts).
 */

import type { PaymentStatus } from "../state-machine/index.ts";

/**
 * The public representation of a Payment this layer returns to its callers.
 * camelCase, free of any Supabase/PostgREST response envelope. Field list
 * matches DATABASE.md section 13 exactly.
 */
export interface Payment {
  id: string;
  orderId: string;
  quoteId: string;
  razorpayOrderId: string | null;
  razorpayPaymentLinkId: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input to createPayment(). `amount`/`currency`/`quoteId` are deliberately
 * absent -- they are derived from the referenced Order row (DATABASE.md
 * section 18 Core Data Integrity Rule 4: "Payment amount must match the
 * approved transaction amount"; ARCHITECTURE.md section 14 step 5), not
 * caller-supplied, for the same "don't trust a value the parent record
 * already carries" reasoning lib/quote/application.ts and
 * lib/order/application.ts already apply to their own creation inputs.
 * `razorpayOrderId`/`razorpayPaymentLinkId` are optional plumbing fields --
 * this phase stores them only if a caller already has them; it never calls
 * Razorpay itself to obtain them (Phase 8 makes no live payment-provider
 * calls). `status` is absent, only the schema's own `status default
 * 'CREATED'`.
 */
export interface CreatePaymentInput {
  orderId: string;
  razorpayOrderId?: string | null;
  razorpayPaymentLinkId?: string | null;
}

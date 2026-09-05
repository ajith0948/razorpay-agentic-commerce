/**
 * The Approval application layer's own public domain types -- same split as
 * every other layer's types.ts (public camelCase shape vs. the raw
 * snake_case row in db.ts).
 *
 * lib/state-machine/approval.ts (Phase 2) already owns the Approval
 * *lifecycle* (PENDING -> APPROVED | REJECTED, both terminal) and its
 * transition function. What did NOT exist before this module is the
 * application boundary around it: a way to *create* a PENDING approval row
 * in the first place (transitionApproval() only moves an existing row
 * between statuses, exactly like transitionOrder()/transitionQuote() never
 * create a row either -- see application.ts) and a typed read path. This
 * module is that boundary, mirroring lib/order's relationship to
 * lib/state-machine/order.ts exactly.
 */

import type { ApprovalStatus } from "../state-machine/index.ts";

/**
 * createApproval()'s input. Deliberately minimal -- merchantId, rfqId, and
 * requestedAmount are NOT accepted here and are instead derived from the
 * referenced Quote row (application.ts), the same "don't trust a value the
 * parent record already carries" principle lib/payment/types.ts's
 * CreatePaymentInput already established (it omits amount/currency/quoteId,
 * deriving them from the Order). An LLM-influenced caller can request
 * approval FOR a quote; it cannot assert what amount that approval is for.
 */
export interface CreateApprovalInput {
  quoteId: string;
  reason: string;
}

/** The public representation of an Approval. */
export interface Approval {
  id: string;
  merchantId: string;
  rfqId: string;
  quoteId: string;
  requestedAmount: number;
  reason: string;
  status: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

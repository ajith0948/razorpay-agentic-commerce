/**
 * The Order application layer's own public domain types -- distinct from
 * the raw database row shape (OrderRow, db.ts), which stays internal to
 * this module. `OrderStatus` itself is imported from lib/state-machine, not
 * redeclared, so the Postgres enum -> TypeScript union mapping continues to
 * have exactly one source of truth (same pattern as lib/quote/types.ts).
 */

import type { OrderStatus } from "../state-machine/index.ts";

/**
 * The public representation of an Order this layer returns to its callers.
 * camelCase, free of any Supabase/PostgREST response envelope. Field list
 * matches DATABASE.md section 14 exactly -- no `paymentId`: section 14 is
 * explicit that "An order does not store a payment_id. Payment.order_id is
 * the only link between the two records", so that field simply does not
 * exist on this type either.
 */
export interface Order {
  id: string;
  merchantId: string;
  buyerId: string;
  rfqId: string;
  quoteId: string;
  totalAmount: number;
  currency: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input to createOrder(). Deliberately just the Quote reference --
 * merchantId/buyerId/rfqId/totalAmount/currency are all derived from the
 * referenced Quote row (every one of them already exists on Quote, see
 * lib/quote/types.ts), so a caller can never supply a value that disagrees
 * with the Quote that authorizes the Order (DATABASE.md section 18 Core
 * Data Integrity Rules 3 and 4). `status` is also absent, for the same
 * reason it is absent from CreateQuoteInput -- never caller input, only the
 * schema's own `status default 'CREATED'`.
 */
export interface CreateOrderInput {
  quoteId: string;
}

/**
 * The Order application/domain layer. This is the ONLY module the rest of
 * the application should import to create, read, or transition an Order.
 *
 * Dependency direction (mirrors lib/quote/application.ts):
 *   Order application layer -> lib/runtime -> lib/state-machine -> Supabase
 *
 * This file owns input validation, the create/read data access calls (via
 * the injected OrderDbClient port, db.ts), the Quote-reference and
 * duplicate-Order checks createOrder() requires, and mapping OrderRow ->
 * Order. It does NOT own a transition table, does NOT duplicate
 * lib/state-machine's ORDER_TRANSITIONS, and NEVER issues
 * `supabase.from("orders").update({status: ...})` itself -- every status
 * change is a lib/runtime AppEvent dispatched through the injected
 * StateRuntime, exactly as lib/quote/application.ts already established.
 *
 * createOrderApplication() takes its dependencies by injection (an
 * OrderDbClient and a StateRuntime), the same DI pattern
 * createQuoteApplication() already established -- so this layer is
 * unit-testable against fakes, with no live Supabase connection (see
 * application.test.ts). createSupabaseOrderApplication() below is the
 * convenience factory real application code calls to get one backed by the
 * live database.
 *
 * Deliberately absent from this file: any call into createPayment() or any
 * other automatic chaining into the Payment application layer.
 * ARCHITECTURE.md section 15 (Webhook Architecture) is the only place in
 * the project's documentation that assigns responsibility for reacting to
 * a Payment event by changing Order state, and that is explicitly the
 * (out-of-scope-for-this-phase) webhook handler's job -- so createOrder()
 * only ever creates the Order row itself. See lib/payment/application.ts's
 * matching doc comment for the same boundary from the other side.
 */

import type { StateRuntime } from "../runtime/index.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import { toStatusDbClient } from "../runtime/supabase-status-db.ts";
import { createStateRuntime } from "../runtime/state-runtime.ts";
import {
  OrderAlreadyExistsError,
  OrderNotFoundError,
  OrderPersistenceError,
  OrderQuoteNotFoundError,
  OrderQuoteStateError,
  OrderValidationError,
} from "./errors.ts";
import type { OrderDbClient, OrderRow } from "./db.ts";
import { toOrderDbClient } from "./supabase-order-db.ts";
import type { CreateOrderInput, Order } from "./types.ts";
import type { OrderTransitionEvent } from "../runtime/events.ts";

/**
 * Everything transitionOrderStatus() needs, mirroring lib/runtime's
 * OrderTransitionEvent minus the `type` discriminant createOrderApplication()
 * supplies itself -- same derivation lib/quote/application.ts's
 * TransitionQuoteStatusInput uses.
 */
export type TransitionOrderStatusInput = Omit<OrderTransitionEvent, "type">;

export interface OrderApplicationDeps {
  db: OrderDbClient;
  runtime: StateRuntime;
}

export interface OrderApplication {
  /**
   * Validates `input`, verifies the referenced Quote exists and is
   * ACCEPTED (DATABASE.md section 18 Core Data Integrity Rule 3), verifies
   * no Order already exists for that Quote (Rule 11 -- see
   * OrderAlreadyExistsError's doc comment for the exact enforcement
   * boundary), inserts the row deriving merchant_id/buyer_id/rfq_id/
   * total_amount/currency from the Quote, and returns it. Does not go
   * through lib/runtime: CREATED has no incoming edge in ORDER_TRANSITIONS
   * (lib/state-machine/order.ts) -- it is never a transition target, only
   * the schema's own `status default 'CREATED'`. This preserves that
   * design rather than routing a non-transition through the transition
   * boundary, exactly as createQuote() does for Quote's own DRAFT default.
   */
  createOrder(input: CreateOrderInput): Promise<Order>;
  /** Throws OrderNotFoundError (not a null return) when no row matches `orderId`. */
  getOrderById(orderId: string): Promise<Order>;
  /**
   * Dispatches an ORDER_TRANSITION event through lib/runtime and returns
   * the Order's fresh state. lib/state-machine remains the sole authority
   * on whether the edge is valid, INCLUDING the PAID/CONFIRMED
   * verified-payment gate (OrderPaymentNotVerifiedError) -- this function
   * adds no Order-specific transition rule of its own. Errors
   * (InvalidTransitionError/StaleTransitionError/TransitionPersistenceError/
   * AuditWriteError/OrderPaymentNotVerifiedError) propagate unchanged from
   * lib/runtime/lib/state-machine.
   */
  transitionOrderStatus(params: TransitionOrderStatusInput): Promise<Order>;
}

/**
 * Quote statuses a new Order may be created against -- DATABASE.md section
 * 18 Core Data Integrity Rule 3: "An accepted quote can create only the
 * appropriate payment/order flow." Unlike QuoteRfqStateError (which derives
 * its terminal-state list from RFQ_TRANSITIONS itself), this is a single
 * named status rather than "non-terminal", because the rule names ACCEPTED
 * specifically -- an Order is not a generic reaction to any live Quote, it
 * is the documented result of a Quote actually being accepted.
 */
const ORDER_ELIGIBLE_QUOTE_STATUS = "ACCEPTED";

function mapOrderRow(row: OrderRow): Order {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    buyerId: row.buyer_id,
    rfqId: row.rfq_id,
    quoteId: row.quote_id,
    totalAmount: row.total_amount,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Application-level input validation -- distinct from and in addition to
 * the database's own NOT NULL/CHECK constraints, which still apply and
 * surface as OrderPersistenceError if violated. CreateOrderInput has a
 * single field, so this has a single check -- same minimal philosophy as
 * lib/quote/application.ts's validateCreateQuoteInput.
 */
function validateCreateOrderInput(input: CreateOrderInput): void {
  if (typeof input.quoteId !== "string" || input.quoteId.trim() === "") {
    throw new OrderValidationError("quoteId", "is required");
  }
}

export function createOrderApplication(deps: OrderApplicationDeps): OrderApplication {
  const { db, runtime } = deps;

  async function getOrderById(orderId: string): Promise<Order> {
    const { data, error } = await db.getOrderById(orderId);

    if (error) {
      throw new OrderPersistenceError("select", error.message);
    }
    if (!data) {
      throw new OrderNotFoundError(orderId);
    }

    return mapOrderRow(data);
  }

  async function createOrder(input: CreateOrderInput): Promise<Order> {
    validateCreateOrderInput(input);

    const { data: quoteRef, error: quoteError } = await db.getQuoteRef(input.quoteId);
    if (quoteError) {
      throw new OrderPersistenceError("select-quote", quoteError.message);
    }
    if (!quoteRef) {
      throw new OrderQuoteNotFoundError(input.quoteId);
    }
    if (quoteRef.status !== ORDER_ELIGIBLE_QUOTE_STATUS) {
      throw new OrderQuoteStateError(input.quoteId, quoteRef.status);
    }

    const { data: existing, error: existingError } = await db.getOrderByQuoteId(input.quoteId);
    if (existingError) {
      throw new OrderPersistenceError("select-existing", existingError.message);
    }
    if (existing) {
      throw new OrderAlreadyExistsError(input.quoteId, existing.id);
    }

    const { data, error } = await db.insertOrder({
      merchant_id: quoteRef.merchant_id,
      buyer_id: quoteRef.buyer_id,
      rfq_id: quoteRef.rfq_id,
      quote_id: quoteRef.id,
      total_amount: quoteRef.total_amount,
      currency: quoteRef.currency,
    });

    if (error) {
      throw new OrderPersistenceError("insert", error.message);
    }
    if (!data) {
      // Defensive: a successful insert-and-select-one should always return
      // the row. Treated as a persistence error, not silently ignored.
      throw new OrderPersistenceError("insert", "insert reported success but returned no row");
    }

    return mapOrderRow(data);
  }

  async function transitionOrderStatus(params: TransitionOrderStatusInput): Promise<Order> {
    await runtime.dispatch({ type: "ORDER_TRANSITION", ...params });
    // dispatch() intentionally returns only {entity, id, status} (see
    // state-runtime.ts) rather than re-reading the row itself. This layer
    // re-fetches so every OrderApplication method returns the same full
    // Order shape, exactly like transitionQuoteStatus() does.
    return getOrderById(params.orderId);
  }

  return { createOrder, getOrderById, transitionOrderStatus };
}

/**
 * Convenience factory for real application code: an OrderApplication backed
 * by the live database. Reuses the existing service-role client factory
 * (lib/supabase/server.ts) and lib/runtime's own toStatusDbClient() adapter
 * -- constructed fresh per call, never at module scope, matching
 * lib/quote/application.ts's createSupabaseQuoteApplication() convention
 * (so this never throws at import/build time if Supabase env vars are
 * unset).
 */
export function createSupabaseOrderApplication(): OrderApplication {
  const supabase = createServiceRoleClient();
  return createOrderApplication({
    db: toOrderDbClient(supabase),
    runtime: createStateRuntime(toStatusDbClient(supabase)),
  });
}

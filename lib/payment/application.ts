/**
 * The Payment application/domain layer. This is the ONLY module the rest of
 * the application should import to create, read, or transition a Payment.
 *
 * Dependency direction (mirrors lib/order/application.ts):
 *   Payment application layer -> lib/runtime -> lib/state-machine -> Supabase
 *
 * This file owns input validation, the create/read data access calls (via
 * the injected PaymentDbClient port, db.ts), the Order-reference check
 * createPayment() requires, and mapping PaymentRow -> Payment. It does NOT
 * own a transition table, does NOT duplicate lib/state-machine's
 * PAYMENT_TRANSITIONS, and NEVER issues
 * `supabase.from("payments").update({status: ...})` itself -- every status
 * change is a lib/runtime AppEvent dispatched through the injected
 * StateRuntime, exactly as lib/order/application.ts already established.
 *
 * Two distinct transition entry points, mirroring lib/state-machine/
 * payment.ts's own split:
 *   - transitionPaymentStatus(): any edge EXCEPT reaching PAID (dispatches
 *     PAYMENT_TRANSITION).
 *   - markPaymentPaid(): the ONLY way to move a Payment to PAID, requiring
 *     PaymentVerificationEvidence (dispatches the pre-existing
 *     PAYMENT_MARK_PAID event -- Phase 8 Step 9's explicit instruction to
 *     reuse it rather than invent a new one).
 *
 * createPaymentApplication() takes its dependencies by injection (a
 * PaymentDbClient and a StateRuntime), the same DI pattern
 * createOrderApplication() already established -- so this layer is
 * unit-testable against fakes, with no live Supabase/Razorpay connection
 * (see application.test.ts). createSupabasePaymentApplication() below is
 * the convenience factory real application code calls to get one backed by
 * the live database.
 *
 * Deliberately absent from this file: any call into the Order application
 * layer to transition the parent Order (e.g. automatically moving an Order
 * to PAYMENT_PENDING when a Payment is created, or to PAID when a Payment
 * is marked paid). See lib/order/application.ts's matching doc comment --
 * that orchestration is the webhook handler's documented responsibility
 * (ARCHITECTURE.md section 15), out of scope for this phase, and Phase 8
 * Step 15 requires Order and Payment creation to remain independently
 * testable rather than auto-chained.
 *
 * No Razorpay SDK integration, no live payment-provider calls: this module
 * only ever stores/reads razorpay_order_id/razorpay_payment_link_id values
 * a caller already has (Phase 8 Step 11).
 */

import type { StateRuntime } from "../runtime/index.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import { toStatusDbClient } from "../runtime/supabase-status-db.ts";
import { createStateRuntime } from "../runtime/state-runtime.ts";
import {
  PaymentNotFoundError,
  PaymentOrderNotFoundError,
  PaymentOrderStateError,
  PaymentPersistenceError,
  PaymentValidationError,
} from "./errors.ts";
import type { PaymentDbClient, PaymentRow } from "./db.ts";
import { toPaymentDbClient } from "./supabase-payment-db.ts";
import type { CreatePaymentInput, Payment } from "./types.ts";
import type { PaymentMarkPaidEvent, PaymentTransitionEvent } from "../runtime/events.ts";
import type { OrderStatus } from "../state-machine/index.ts";

/**
 * Everything transitionPaymentStatus() needs, mirroring lib/runtime's
 * PaymentTransitionEvent minus the `type` discriminant
 * createPaymentApplication() supplies itself -- same derivation
 * lib/order/application.ts's TransitionOrderStatusInput uses.
 */
export type TransitionPaymentStatusInput = Omit<PaymentTransitionEvent, "type">;

/** Everything markPaymentPaid() needs, mirroring lib/runtime's PaymentMarkPaidEvent minus `type`. */
export type MarkPaymentPaidInput = Omit<PaymentMarkPaidEvent, "type">;

export interface PaymentApplicationDeps {
  db: PaymentDbClient;
  runtime: StateRuntime;
}

export interface PaymentApplication {
  /**
   * Validates `input`, verifies the referenced Order exists and is
   * eligible to receive a new Payment attempt (see
   * PAYMENT_ELIGIBLE_ORDER_STATUSES below), derives amount/currency/quoteId
   * from the Order (DATABASE.md section 18 Core Data Integrity Rule 4:
   * "Payment amount must match the approved transaction amount"), inserts
   * the row, and returns it. Does not go through lib/runtime: CREATED has
   * no incoming edge in PAYMENT_TRANSITIONS (lib/state-machine/payment.ts)
   * -- it is never a transition target, only the schema's own `status
   * default 'CREATED'`.
   */
  createPayment(input: CreatePaymentInput): Promise<Payment>;
  /** Throws PaymentNotFoundError (not a null return) when no row matches `paymentId`. */
  getPaymentById(paymentId: string): Promise<Payment>;
  /**
   * Dispatches a PAYMENT_TRANSITION event through lib/runtime and returns
   * the Payment's fresh state. Cannot reach PAID -- use markPaymentPaid()
   * for that; lib/state-machine itself also enforces this (throws
   * PaymentPaidRequiresVerificationError if attempted). Errors
   * (InvalidTransitionError/StaleTransitionError/TransitionPersistenceError/
   * AuditWriteError/PaymentPaidRequiresVerificationError) propagate
   * unchanged from lib/runtime/lib/state-machine.
   */
  transitionPaymentStatus(params: TransitionPaymentStatusInput): Promise<Payment>;
  /**
   * Dispatches a PAYMENT_MARK_PAID event through lib/runtime -- the only
   * way this application layer moves a Payment to PAID, requiring
   * PaymentVerificationEvidence as a mandatory argument (Phase 8 Step 9).
   * Returns the Payment's fresh state.
   */
  markPaymentPaid(params: MarkPaymentPaidInput): Promise<Payment>;
}

/**
 * Order statuses a new Payment attempt may be created against.
 * lib/state-machine/order.ts's own doc comment on ORDER_TRANSITIONS
 * explains that a failed payment retries via a *new* Payment row against
 * an order still in PAYMENT_PENDING, rather than moving Order.status
 * backward -- so PAYMENT_PENDING must remain payment-eligible. CREATED is
 * also eligible: it is the Order's state before any Payment attempt has
 * been made at all (nothing in this phase auto-transitions an Order to
 * PAYMENT_PENDING when its first Payment is created -- see this file's top
 * doc comment on no auto-chaining), so the very first createPayment() call
 * against a given Order necessarily happens while it is still CREATED.
 * PAID, CONFIRMED, PAYMENT_FAILED, and CANCELLED are all excluded: PAID/
 * CONFIRMED already have a verified successful payment (and a second would
 * additionally be rejected by the payments_reject_if_order_paid database
 * trigger); PAYMENT_FAILED and CANCELLED are terminal Order states with no
 * legitimate reason to accept a new payment.
 */
const PAYMENT_ELIGIBLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "CREATED",
  "PAYMENT_PENDING",
]);

function mapPaymentRow(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.order_id,
    quoteId: row.quote_id,
    razorpayOrderId: row.razorpay_order_id,
    razorpayPaymentLinkId: row.razorpay_payment_link_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Application-level input validation -- distinct from and in addition to
 * the database's own NOT NULL/CHECK/UNIQUE constraints, which still apply
 * and surface as PaymentPersistenceError if violated. Deliberately
 * minimal, same philosophy as lib/order/application.ts's
 * validateCreateOrderInput.
 */
function validateCreatePaymentInput(input: CreatePaymentInput): void {
  if (typeof input.orderId !== "string" || input.orderId.trim() === "") {
    throw new PaymentValidationError("orderId", "is required");
  }
  if (
    input.razorpayOrderId !== undefined &&
    input.razorpayOrderId !== null &&
    (typeof input.razorpayOrderId !== "string" || input.razorpayOrderId.trim() === "")
  ) {
    throw new PaymentValidationError(
      "razorpayOrderId",
      "must be a non-empty string when provided",
    );
  }
  if (
    input.razorpayPaymentLinkId !== undefined &&
    input.razorpayPaymentLinkId !== null &&
    (typeof input.razorpayPaymentLinkId !== "string" || input.razorpayPaymentLinkId.trim() === "")
  ) {
    throw new PaymentValidationError(
      "razorpayPaymentLinkId",
      "must be a non-empty string when provided",
    );
  }
}

export function createPaymentApplication(deps: PaymentApplicationDeps): PaymentApplication {
  const { db, runtime } = deps;

  async function getPaymentById(paymentId: string): Promise<Payment> {
    const { data, error } = await db.getPaymentById(paymentId);

    if (error) {
      throw new PaymentPersistenceError("select", error.message);
    }
    if (!data) {
      throw new PaymentNotFoundError(paymentId);
    }

    return mapPaymentRow(data);
  }

  async function createPayment(input: CreatePaymentInput): Promise<Payment> {
    validateCreatePaymentInput(input);

    const { data: orderRef, error: orderError } = await db.getOrderRef(input.orderId);
    if (orderError) {
      throw new PaymentPersistenceError("select-order", orderError.message);
    }
    if (!orderRef) {
      throw new PaymentOrderNotFoundError(input.orderId);
    }
    if (!PAYMENT_ELIGIBLE_ORDER_STATUSES.has(orderRef.status)) {
      throw new PaymentOrderStateError(input.orderId, orderRef.status);
    }

    const { data, error } = await db.insertPayment({
      order_id: orderRef.id,
      quote_id: orderRef.quote_id,
      amount: orderRef.total_amount,
      currency: orderRef.currency,
      razorpay_order_id: input.razorpayOrderId ?? null,
      razorpay_payment_link_id: input.razorpayPaymentLinkId ?? null,
    });

    if (error) {
      throw new PaymentPersistenceError("insert", error.message);
    }
    if (!data) {
      // Defensive: a successful insert-and-select-one should always return
      // the row. Treated as a persistence error, not silently ignored.
      throw new PaymentPersistenceError("insert", "insert reported success but returned no row");
    }

    return mapPaymentRow(data);
  }

  async function transitionPaymentStatus(params: TransitionPaymentStatusInput): Promise<Payment> {
    await runtime.dispatch({ type: "PAYMENT_TRANSITION", ...params });
    // dispatch() intentionally returns only {entity, id, status} (see
    // state-runtime.ts) rather than re-reading the row itself. This layer
    // re-fetches so every PaymentApplication method returns the same full
    // Payment shape, exactly like transitionOrderStatus() does.
    return getPaymentById(params.paymentId);
  }

  async function markPaymentPaid(params: MarkPaymentPaidInput): Promise<Payment> {
    await runtime.dispatch({ type: "PAYMENT_MARK_PAID", ...params });
    return getPaymentById(params.paymentId);
  }

  return { createPayment, getPaymentById, transitionPaymentStatus, markPaymentPaid };
}

/**
 * Convenience factory for real application code: a PaymentApplication
 * backed by the live database. Reuses the existing service-role client
 * factory (lib/supabase/server.ts) and lib/runtime's own
 * toStatusDbClient() adapter -- constructed fresh per call, never at
 * module scope, matching lib/order/application.ts's
 * createSupabaseOrderApplication() convention (so this never throws at
 * import/build time if Supabase env vars are unset).
 */
export function createSupabasePaymentApplication(): PaymentApplication {
  const supabase = createServiceRoleClient();
  return createPaymentApplication({
    db: toPaymentDbClient(supabase),
    runtime: createStateRuntime(toStatusDbClient(supabase)),
  });
}

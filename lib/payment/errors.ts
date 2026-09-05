/**
 * Controlled error types for the Payment application layer -- same
 * philosophy as lib/order/errors.ts and lib/quote/errors.ts (named classes,
 * never a bare string throw), kept in this module because none of them
 * duplicate a Phase 2 (lib/state-machine) concern:
 *
 *   - PaymentValidationError: input validation, mirrors OrderValidationError.
 *   - PaymentNotFoundError: a plain "no row with this id" result, distinct
 *     from lib/state-machine's StaleTransitionError, a transition concept
 *     getPaymentById() never invokes.
 *   - PaymentPersistenceError: a database failure during a plain
 *     insert/select, not a transition.
 *   - PaymentOrderNotFoundError: createPayment()'s referenced orderId does
 *     not exist. Deliberately NOT lib/order's OrderNotFoundError -- this
 *     layer does not depend on lib/order at all (see db.ts's doc comment),
 *     it only reads the minimal order fields it needs directly, mirroring
 *     why OrderQuoteNotFoundError exists instead of reusing lib/quote's
 *     QuoteNotFoundError.
 *   - PaymentOrderStateError: the referenced Order exists but is not in a
 *     state that may receive a new Payment (CREATED or PAYMENT_PENDING --
 *     see lib/order/application.ts's doc comment on
 *     PAYMENT_ELIGIBLE_ORDER_STATUSES for why PAYMENT_FAILED is not
 *     included). Not an InvalidTransitionError -- no Order transition is
 *     being attempted here, this is a Payment-creation precondition on a
 *     *related* entity's state.
 *
 * Lifecycle-transition failures (InvalidTransitionError,
 * StaleTransitionError, TransitionPersistenceError, AuditWriteError,
 * PaymentPaidRequiresVerificationError, ...) are never re-thrown as one of
 * these -- transitionPaymentStatus() and markPaymentPaid() let
 * lib/runtime's/lib/state-machine's own errors propagate unchanged.
 */

/** One field of a createPayment() input failed validation. */
export class PaymentValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid Payment input: ${field} ${reason}`);
    this.name = "PaymentValidationError";
    this.field = field;
  }
}

/** No Payment exists with the given id. */
export class PaymentNotFoundError extends Error {
  readonly paymentId: string;

  constructor(paymentId: string) {
    super(`Payment ${paymentId} not found`);
    this.name = "PaymentNotFoundError";
    this.paymentId = paymentId;
  }
}

/** The database rejected a plain (non-transition) Payment/Order read or the Payment insert. */
export class PaymentPersistenceError extends Error {
  readonly operation: "insert" | "select" | "select-order";

  constructor(operation: PaymentPersistenceError["operation"], cause: string) {
    super(`Database error on Payment ${operation}: ${cause}`);
    this.name = "PaymentPersistenceError";
    this.operation = operation;
  }
}

/** createPayment() was given an orderId that does not reference any existing Order. */
export class PaymentOrderNotFoundError extends Error {
  readonly orderId: string;

  constructor(orderId: string) {
    super(`Cannot create Payment: Order ${orderId} not found`);
    this.name = "PaymentOrderNotFoundError";
    this.orderId = orderId;
  }
}

/**
 * createPayment() was given an orderId whose Order exists but is not
 * eligible to receive a new Payment attempt.
 */
export class PaymentOrderStateError extends Error {
  readonly orderId: string;
  readonly orderStatus: string;

  constructor(orderId: string, orderStatus: string) {
    super(`Cannot create Payment: Order ${orderId} is in state ${orderStatus}`);
    this.name = "PaymentOrderStateError";
    this.orderId = orderId;
    this.orderStatus = orderStatus;
  }
}

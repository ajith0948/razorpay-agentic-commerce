/**
 * Controlled error types for the Order application layer -- same philosophy
 * as lib/quote/errors.ts (named classes, never a bare string throw), kept in
 * this module because none of them duplicate a Phase 2 (lib/state-machine)
 * concern:
 *
 *   - OrderValidationError: input validation, mirrors QuoteValidationError.
 *   - OrderNotFoundError: a plain "no row with this id" result, mirrors
 *     QuoteNotFoundError -- distinct from lib/state-machine's
 *     StaleTransitionError, which means a compare-and-swap update matched
 *     zero rows, a transition concept getOrderById() never invokes.
 *   - OrderPersistenceError: a database failure during a plain
 *     insert/select, not a transition. Mirrors QuotePersistenceError.
 *   - OrderQuoteNotFoundError: createOrder()'s referenced quoteId does not
 *     exist. Deliberately NOT lib/quote's QuoteNotFoundError -- this layer
 *     does not depend on lib/quote at all (see db.ts's doc comment), it
 *     only reads the minimal quote fields it needs directly, so it needs
 *     its own error for this genuinely Order-specific concern ("the
 *     reference I was given is invalid"), mirroring why QuoteRfqNotFoundError
 *     exists instead of reusing lib/rfq's RfqNotFoundError.
 *   - OrderQuoteStateError: the referenced Quote exists but is not ACCEPTED
 *     (DATABASE.md section 18 Core Data Integrity Rule 3: "An accepted
 *     quote can create only the appropriate payment/order flow"). Not an
 *     InvalidTransitionError -- no Quote transition is being attempted
 *     here, this is an Order-creation precondition on a *related* entity's
 *     state, which lib/state-machine has no concept of.
 *   - OrderAlreadyExistsError: an Order already exists for the referenced
 *     Quote. The `orders` table has no unique constraint on quote_id (see
 *     db.ts's doc comment), so this is an application-level enforcement of
 *     DATABASE.md section 18 Core Data Integrity Rule 11 ("Duplicate
 *     financial events must not create duplicate payments or orders"), not
 *     a database-guaranteed one -- reported as a known gap in the Phase 8
 *     report rather than silently patched with an unrequested migration.
 *
 * Lifecycle-transition failures (InvalidTransitionError,
 * StaleTransitionError, TransitionPersistenceError, AuditWriteError,
 * OrderPaymentNotVerifiedError, ...) are never re-thrown as one of these --
 * transitionOrderStatus() lets lib/runtime's/lib/state-machine's own errors
 * propagate unchanged.
 */

/** One field of a createOrder() input failed validation. */
export class OrderValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid Order input: ${field} ${reason}`);
    this.name = "OrderValidationError";
    this.field = field;
  }
}

/** No Order exists with the given id. */
export class OrderNotFoundError extends Error {
  readonly orderId: string;

  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = "OrderNotFoundError";
    this.orderId = orderId;
  }
}

/** The database rejected a plain (non-transition) Order/Quote read, the duplicate check, or the Order insert. */
export class OrderPersistenceError extends Error {
  readonly operation: "insert" | "select" | "select-quote" | "select-existing";

  constructor(operation: OrderPersistenceError["operation"], cause: string) {
    super(`Database error on Order ${operation}: ${cause}`);
    this.name = "OrderPersistenceError";
    this.operation = operation;
  }
}

/** createOrder() was given a quoteId that does not reference any existing Quote. */
export class OrderQuoteNotFoundError extends Error {
  readonly quoteId: string;

  constructor(quoteId: string) {
    super(`Cannot create Order: Quote ${quoteId} not found`);
    this.name = "OrderQuoteNotFoundError";
    this.quoteId = quoteId;
  }
}

/**
 * createOrder() was given a quoteId whose Quote exists but is not ACCEPTED
 * (DATABASE.md section 18 Core Data Integrity Rule 3).
 */
export class OrderQuoteStateError extends Error {
  readonly quoteId: string;
  readonly quoteStatus: string;

  constructor(quoteId: string, quoteStatus: string) {
    super(`Cannot create Order: Quote ${quoteId} is in state ${quoteStatus}, not ACCEPTED`);
    this.name = "OrderQuoteStateError";
    this.quoteId = quoteId;
    this.quoteStatus = quoteStatus;
  }
}

/**
 * createOrder() was given a quoteId that already has an Order created
 * against it. See this file's doc comment: enforced at the application
 * layer only, since the schema places no unique constraint on
 * orders.quote_id.
 */
export class OrderAlreadyExistsError extends Error {
  readonly quoteId: string;
  readonly existingOrderId: string;

  constructor(quoteId: string, existingOrderId: string) {
    super(`Cannot create Order: Quote ${quoteId} already has Order ${existingOrderId}`);
    this.name = "OrderAlreadyExistsError";
    this.quoteId = quoteId;
    this.existingOrderId = existingOrderId;
  }
}

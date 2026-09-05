/**
 * Controlled error types for the state machine.
 *
 * Every failure mode a caller can hit from this module is one of these
 * named classes (never a bare string throw / rejected value), so calling
 * code -- API routes, agent tools, tests -- can branch on `instanceof`
 * instead of parsing messages.
 */

/** A transition was requested that is not in the entity's transition table. */
export class InvalidTransitionError extends Error {
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

/**
 * The conditional (compare-and-swap) update affected zero rows: either the
 * row does not exist, or its actual current status no longer matches the
 * `from` the caller believed it to be in (a concurrent transition already
 * moved it, or the caller's belief was stale). Deliberately not
 * disambiguated further -- doing so would require an extra read on every
 * failure path for a distinction callers rarely need to act on
 * differently.
 */
export class StaleTransitionError extends Error {
  readonly table: string;
  readonly id: string;
  readonly from: string;
  readonly to: string;

  constructor(table: string, id: string, from: string, to: string) {
    super(
      `Could not transition ${table} row ${id} from ${from} to ${to}: ` +
        `no row matched that id with that current status (it does not ` +
        `exist, or was already moved by a concurrent transition).`,
    );
    this.name = "StaleTransitionError";
    this.table = table;
    this.id = id;
    this.from = from;
    this.to = to;
  }
}

/** The database rejected a read or write. Wraps the underlying PostgREST error message. */
export class TransitionPersistenceError extends Error {
  readonly table: string;
  readonly id: string;

  constructor(table: string, id: string, cause: string) {
    super(`Database error transitioning ${table} row ${id}: ${cause}`);
    this.name = "TransitionPersistenceError";
    this.table = table;
    this.id = id;
  }
}

/**
 * The status update for a transition committed, but writing its audit
 * event failed. Thrown rather than swallowed so the failure is never
 * silent (AGENTS.md section 8: audit logs must be append-only from normal
 * application flows -- a transition that succeeds with no audit trail is a
 * problem the caller must know about), even though -- without a
 * multi-statement database transaction wrapping both writes, which this
 * phase does not introduce -- the status change itself is not rolled back.
 */
export class AuditWriteError extends Error {
  readonly eventType: string;

  constructor(eventType: string, cause: string) {
    super(
      `Status transition succeeded but its audit event ("${eventType}") ` +
        `failed to write: ${cause}`,
    );
    this.name = "AuditWriteError";
    this.eventType = eventType;
  }
}

/**
 * Payment.status cannot become PAID through the generic transition
 * function -- AGENTS.md section 6 / DATABASE.md section 13: payment
 * success must be confirmed through verified Razorpay backend events, never
 * an arbitrary application status update. Callers must use
 * markPaymentPaid(), which requires verification evidence as a mandatory
 * argument.
 */
export class PaymentPaidRequiresVerificationError extends Error {
  readonly paymentId: string;

  constructor(paymentId: string) {
    super(
      `Payment ${paymentId} cannot become PAID through transitionPayment(); ` +
        `use markPaymentPaid() with verified Razorpay evidence instead.`,
    );
    this.name = "PaymentPaidRequiresVerificationError";
    this.paymentId = paymentId;
  }
}

/**
 * Order.status cannot become PAID or CONFIRMED unless a Payment row for
 * this order has actually reached PAID (i.e. was set via
 * markPaymentPaid(), which itself requires verified Razorpay evidence).
 */
export class OrderPaymentNotVerifiedError extends Error {
  readonly orderId: string;
  readonly attemptedStatus: string;

  constructor(orderId: string, attemptedStatus: string) {
    super(
      `Order ${orderId} cannot become ${attemptedStatus}: no payment for ` +
        `this order has a verified PAID status yet.`,
    );
    this.name = "OrderPaymentNotVerifiedError";
    this.orderId = orderId;
    this.attemptedStatus = attemptedStatus;
  }
}

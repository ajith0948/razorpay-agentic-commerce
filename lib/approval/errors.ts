/**
 * Controlled error types for the Approval application layer -- same
 * philosophy as lib/order/errors.ts. None of these duplicate a Phase 2
 * (lib/state-machine) concern:
 *
 *   - ApprovalValidationError: input validation for createApproval(),
 *     mirrors OrderValidationError.
 *   - ApprovalNotFoundError: a plain "no row with this id" result, mirrors
 *     OrderNotFoundError -- distinct from lib/state-machine's
 *     StaleTransitionError.
 *   - ApprovalPersistenceError: a database failure during a plain
 *     insert/select, not a transition. Mirrors OrderPersistenceError.
 *   - ApprovalQuoteNotFoundError: createApproval()'s referenced quoteId
 *     does not exist. Mirrors OrderQuoteNotFoundError exactly, including
 *     the same reasoning for why this is not lib/quote's own
 *     QuoteNotFoundError (this layer does not depend on lib/quote, see
 *     db.ts's doc comment).
 *
 * Deliberately absent: no "ApprovalQuoteStateError" -- unlike Order's
 * createOrder() (which DATABASE.md section 18 Core Data Integrity Rule 3
 * explicitly gates on Quote status ACCEPTED), no documented source gates
 * *requesting* approval on the referenced Quote being in any particular
 * status. Inventing such a gate here would be exactly the kind of
 * unrequested policy/precondition Phase 9's spec prohibits; see
 * application.ts's doc comment.
 *
 * Lifecycle-transition failures (InvalidTransitionError, StaleTransitionError,
 * TransitionPersistenceError, AuditWriteError, ...) are never re-thrown as
 * one of these -- transitionApprovalStatus() lets lib/runtime's/
 * lib/state-machine's own errors propagate unchanged.
 */

/** One field of a createApproval() input failed validation. */
export class ApprovalValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid Approval input: ${field} ${reason}`);
    this.name = "ApprovalValidationError";
    this.field = field;
  }
}

/** No Approval exists with the given id. */
export class ApprovalNotFoundError extends Error {
  readonly approvalId: string;

  constructor(approvalId: string) {
    super(`Approval ${approvalId} not found`);
    this.name = "ApprovalNotFoundError";
    this.approvalId = approvalId;
  }
}

/** The database rejected a plain (non-transition) Approval/Quote read or the Approval insert. */
export class ApprovalPersistenceError extends Error {
  readonly operation: "insert" | "select" | "select-quote" | "select-latest";

  constructor(operation: ApprovalPersistenceError["operation"], cause: string) {
    super(`Database error on Approval ${operation}: ${cause}`);
    this.name = "ApprovalPersistenceError";
    this.operation = operation;
  }
}

/** createApproval() was given a quoteId that does not reference any existing Quote. */
export class ApprovalQuoteNotFoundError extends Error {
  readonly quoteId: string;

  constructor(quoteId: string) {
    super(`Cannot create Approval: Quote ${quoteId} not found`);
    this.name = "ApprovalQuoteNotFoundError";
    this.quoteId = quoteId;
  }
}

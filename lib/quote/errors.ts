/**
 * Controlled error types for the Quote application layer -- same philosophy
 * as lib/rfq/errors.ts (named classes, never a bare string throw), kept in
 * this module because none of them duplicate a Phase 2 (lib/state-machine)
 * concern:
 *
 *   - QuoteValidationError: input validation, mirrors RfqValidationError.
 *   - QuoteNotFoundError: a plain "no row with this id" result, mirrors
 *     RfqNotFoundError -- distinct from lib/state-machine's
 *     StaleTransitionError, which means a compare-and-swap update matched
 *     zero rows, a transition concept getQuoteById() never invokes.
 *   - QuotePersistenceError: a database failure during a plain
 *     insert/select, not a transition. Mirrors RfqPersistenceError.
 *   - QuoteRfqNotFoundError: createQuote()'s referenced rfq_id does not
 *     exist. Deliberately NOT lib/rfq's RfqNotFoundError -- this layer does
 *     not depend on lib/rfq at all (see db.ts's doc comment), it only reads
 *     the minimal rfq fields it needs directly, so it needs its own error
 *     for this genuinely Quote-specific concern ("the reference I was given
 *     is invalid"), per Step 9's explicit instruction to add one for "RFQ
 *     reference invalid".
 *   - QuoteRfqStateError: the referenced RFQ exists but is not in a state
 *     that may receive a new Quote (DATABASE.md section 9's terminal RFQ
 *     states). Not an InvalidTransitionError -- no RFQ transition is being
 *     attempted here, this is a Quote-creation precondition on a *related*
 *     entity's state, which lib/state-machine has no concept of.
 *   - QuotePolicyLimitError: discount_percent exceeds the merchant's active
 *     policy's max_discount_percent (DATABASE.md section 10: "A quote must
 *     never exceed merchant policy limits"). Not the (not-yet-built) policy
 *     engine's concern -- this is one narrow, already-documented limit
 *     checked with existing policy values, not a general policy decision.
 *
 * Lifecycle-transition failures (InvalidTransitionError,
 * StaleTransitionError, TransitionPersistenceError, AuditWriteError, ...)
 * are never re-thrown as one of these -- transitionQuoteStatus() lets
 * lib/runtime's/lib/state-machine's own errors propagate unchanged.
 */

/** One field of a createQuote() input failed validation. */
export class QuoteValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid Quote input: ${field} ${reason}`);
    this.name = "QuoteValidationError";
    this.field = field;
  }
}

/** No Quote exists with the given id. */
export class QuoteNotFoundError extends Error {
  readonly quoteId: string;

  constructor(quoteId: string) {
    super(`Quote ${quoteId} not found`);
    this.name = "QuoteNotFoundError";
    this.quoteId = quoteId;
  }
}

/** The database rejected a plain (non-transition) Quote/RFQ/policy read or the Quote insert. */
export class QuotePersistenceError extends Error {
  readonly operation: "insert" | "select" | "select-rfq" | "select-policy";

  constructor(operation: QuotePersistenceError["operation"], cause: string) {
    super(`Database error on Quote ${operation}: ${cause}`);
    this.name = "QuotePersistenceError";
    this.operation = operation;
  }
}

/** createQuote() was given an rfqId that does not reference any existing RFQ. */
export class QuoteRfqNotFoundError extends Error {
  readonly rfqId: string;

  constructor(rfqId: string) {
    super(`Cannot create Quote: RFQ ${rfqId} not found`);
    this.name = "QuoteRfqNotFoundError";
    this.rfqId = rfqId;
  }
}

/**
 * createQuote() was given an rfqId whose RFQ exists but is in a terminal
 * state (no outgoing edges in RFQ_TRANSITIONS -- ACCEPTED, REJECTED,
 * EXPIRED, CANCELLED, or FAILED), so it can never legitimately receive a
 * new Quote.
 */
export class QuoteRfqStateError extends Error {
  readonly rfqId: string;
  readonly rfqStatus: string;

  constructor(rfqId: string, rfqStatus: string) {
    super(`Cannot create Quote: RFQ ${rfqId} is in terminal state ${rfqStatus}`);
    this.name = "QuoteRfqStateError";
    this.rfqId = rfqId;
    this.rfqStatus = rfqStatus;
  }
}

/**
 * createQuote()'s discount_percent exceeds the merchant's active policy's
 * max_discount_percent.
 */
export class QuotePolicyLimitError extends Error {
  readonly discountPercent: number;
  readonly maxDiscountPercent: number;

  constructor(discountPercent: number, maxDiscountPercent: number) {
    super(
      `Quote discount_percent ${discountPercent} exceeds merchant policy limit ${maxDiscountPercent}`,
    );
    this.name = "QuotePolicyLimitError";
    this.discountPercent = discountPercent;
    this.maxDiscountPercent = maxDiscountPercent;
  }
}

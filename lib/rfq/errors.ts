/**
 * Controlled error types for the RFQ application layer -- same philosophy
 * as lib/state-machine/errors.ts (named classes, never a bare string
 * throw), kept in this module because none of them duplicate a Phase 2
 * concern:
 *
 *   - RfqValidationError: input validation, which lib/state-machine has no
 *     equivalent of (it validates transitions, not creation input).
 *   - RfqNotFoundError: a plain "no row with this id" result, distinct from
 *     StaleTransitionError (which specifically means a compare-and-swap
 *     update matched zero rows -- a transition concept this layer's
 *     read-only getRfqById() never invokes).
 *   - RfqPersistenceError: a database failure during a plain insert/select,
 *     not a transition. Deliberately NOT lib/state-machine's
 *     TransitionPersistenceError, whose message text ("Database error
 *     transitioning...") would misdescribe a create/read failure that has
 *     nothing to do with a status transition.
 *   - RfqRequirementsParsingError: raw_request could not be reduced to the
 *     minimum structured fields a quote calculation needs. Not a
 *     lib/state-machine concern (parsing has no notion in Phase 2's
 *     transition tables) and not a persistence failure (nothing was
 *     written or failed to write) -- a distinct third failure category
 *     this layer owns.
 *
 * Lifecycle-transition failures (InvalidTransitionError,
 * StaleTransitionError, TransitionPersistenceError, AuditWriteError, ...)
 * are never re-thrown as one of these -- transitionRfqStatus() lets
 * lib/runtime's/lib/state-machine's own errors propagate unchanged.
 */

/** One field of a createRfq() input failed validation. */
export class RfqValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid RFQ input: ${field} ${reason}`);
    this.name = "RfqValidationError";
    this.field = field;
  }
}

/** No RFQ exists with the given id. */
export class RfqNotFoundError extends Error {
  readonly rfqId: string;

  constructor(rfqId: string) {
    super(`RFQ ${rfqId} not found`);
    this.name = "RfqNotFoundError";
    this.rfqId = rfqId;
  }
}

/** The database rejected a plain (non-transition) RFQ read or write. */
export class RfqPersistenceError extends Error {
  readonly operation: "insert" | "select";

  constructor(operation: "insert" | "select", cause: string) {
    super(`Database error on RFQ ${operation}: ${cause}`);
    this.name = "RfqPersistenceError";
    this.operation = operation;
  }
}

/**
 * raw_request could not be parsed into the required structured fields
 * (quantity, product -- see requirements-parser.ts's module doc comment for
 * why exactly these two). Mirrors ARCHITECTURE.md section 26's "RFQ
 * Failure" guidance ("Missing quantity" / "Missing product requirements" ->
 * "Ask the buyer for the missing information"): `missingFields` carries
 * exactly what a caller (an HTTP route today; a future clarification UI or
 * agent tool later) needs to ask the buyer for.
 */
export class RfqRequirementsParsingError extends Error {
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[]) {
    super(`Could not extract required RFQ requirements: missing ${missingFields.join(", ")}`);
    this.name = "RfqRequirementsParsingError";
    this.missingFields = missingFields;
  }
}

/**
 * Controlled error types for the Policy application layer -- same
 * philosophy as lib/order/errors.ts (named classes, never a bare string
 * throw). Deliberately small: unlike every other layer's errors.ts, there
 * is no "NotFoundError" here, because "the merchant has no active policy
 * row" is not a fault -- it is a legitimate outcome evaluate() reports as
 * PolicyDecision.outcome === "BLOCKED" with policy: null (see
 * application.ts's doc comment). Modelling it as a thrown error would force
 * every caller (including Agent tool handlers) to catch-and-recover on the
 * single most safety-critical code path in this codebase; a typed return
 * value is harder to accidentally ignore than a catch block is to
 * accidentally omit.
 *
 * Likewise there is no "PolicyViolationError": a BLOCKED verdict is the
 * Policy Engine doing its job correctly, not failing -- ARCHITECTURE.md
 * section 9's own framing ("The Policy Engine decides whether it is
 * permitted") describes a decision, not an exception. evaluate() never
 * throws for a policy violation; it returns PolicyDecision with
 * outcome: "BLOCKED".
 */

/** One field of a PolicyEvaluationInput failed basic shape validation. */
export class PolicyValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid policy evaluation input: ${field} ${reason}`);
    this.name = "PolicyValidationError";
    this.field = field;
  }
}

/** The database rejected a plain (non-transition) merchant policy read. */
export class PolicyPersistenceError extends Error {
  readonly operation: "select";

  constructor(operation: "select", cause: string) {
    super(`Database error on Policy ${operation}: ${cause}`);
    this.name = "PolicyPersistenceError";
    this.operation = operation;
  }
}

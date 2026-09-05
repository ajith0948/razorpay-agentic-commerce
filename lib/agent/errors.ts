/**
 * Controlled error classes for the Agent Session boundary (session.ts).
 * Mirrors every other layer's errors.ts style (lib/approval/errors.ts,
 * lib/order/errors.ts, ...): named classes, never a bare string throw, and
 * fields assigned explicitly in the constructor body rather than via
 * TS parameter-property shorthand -- lib/state-machine/test-support.ts's
 * doc comment records why: `node --test` on this project's raw .ts files
 * uses Node's native type-stripping, which throws
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX on parameter properties (erasing them
 * isn't a pure type-level strip -- it has to synthesize an assignment).
 *
 * The Tool registry (tools.ts) deliberately does NOT throw these -- or any
 * error -- out of executeTool(). Every tool call, success or failure,
 * resolves to a ToolResult (types.ts). These classes exist only for
 * AgentSessionApplication's create/get/transition surface, the same shape
 * every other application layer's own errors.ts provides.
 */

/** One field of a createSession() input failed validation. */
export class AgentSessionValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`agent session validation failed for '${field}': ${reason}`);
    this.name = "AgentSessionValidationError";
    this.field = field;
  }
}

/** No Agent Session exists with the given id. */
export class AgentSessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`agent session not found: ${sessionId}`);
    this.name = "AgentSessionNotFoundError";
    this.sessionId = sessionId;
  }
}

/** createSession() was given an rfqId that does not reference any existing Rfq. */
export class AgentSessionRfqNotFoundError extends Error {
  readonly rfqId: string;

  constructor(rfqId: string) {
    super(`cannot start agent session: rfq not found: ${rfqId}`);
    this.name = "AgentSessionRfqNotFoundError";
    this.rfqId = rfqId;
  }
}

/** The database rejected a plain (non-transition) Agent Session read, Rfq-reference read, or insert. */
export class AgentSessionPersistenceError extends Error {
  readonly operation: "insert" | "select" | "select-rfq";

  constructor(operation: AgentSessionPersistenceError["operation"], reason: string) {
    super(`agent session persistence failure during '${operation}': ${reason}`);
    this.name = "AgentSessionPersistenceError";
    this.operation = operation;
  }
}

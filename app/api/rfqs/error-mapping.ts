/**
 * Shared HTTP error-response helpers for the RFQ API routes
 * (app/api/rfqs/route.ts and app/api/rfqs/[id]/route.ts). Not a route itself
 * -- no HTTP method exports -- so Next.js's App Router does not treat this
 * file as a Route Handler.
 *
 * Extracted (Phase 10A) from what was originally a private function inside
 * route.ts, for the same reason app/api/quotes/error-mapping.ts already
 * exists: two RFQ routes now need to map the same RfqApplication error types
 * to the same responses, and duplicating the mapping instead of sharing it
 * would diverge from the Quote API's own precedent. Behavior is unchanged
 * from the original private mapRfqErrorToResponse() in route.ts -- this is a
 * pure extraction, not a rewrite.
 *
 * Deliberately does NOT handle RfqRequirementsParsingError -- that error is
 * only ever thrown by processRfqRequirements() after createRfq() has already
 * succeeded, and its 422 response needs the already-created rfqId, which
 * this generic mapper has no way to supply. handleCreateRfq() (route.ts)
 * catches that one case itself, with the id in scope, before falling back to
 * this function for everything else. GET /api/rfqs/:id never reaches
 * processRfqRequirements() at all, so it never needs that special case.
 */

import { RfqNotFoundError, RfqValidationError } from "../../../lib/rfq/index.ts";
// RfqPersistenceError/TransitionPersistenceError/AuditWriteError are
// deliberately NOT imported for an instanceof check here -- they fall
// through to the default branch below to a generic 500, which is the
// correct (and only safe) response for all three: each wraps a raw database
// error message that must never reach the client.
import { InvalidTransitionError, StaleTransitionError } from "../../../lib/state-machine/index.ts";

/** Uniform error envelope for every non-2xx response the RFQ API returns. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Maps an error thrown by RfqApplication to a safe HTTP response.
 *
 *   400 VALIDATION_ERROR    -- RfqValidationError (bad input)
 *   404 RFQ_NOT_FOUND       -- RfqNotFoundError
 *   409 TRANSITION_CONFLICT -- StaleTransitionError/InvalidTransitionError
 *   500 INTERNAL_ERROR      -- RfqPersistenceError and anything else
 */
export function mapRfqErrorToResponse(err: unknown): Response {
  if (err instanceof RfqValidationError) {
    return errorResponse(400, "VALIDATION_ERROR", err.message, { field: err.field });
  }
  if (err instanceof RfqNotFoundError) {
    return errorResponse(404, "RFQ_NOT_FOUND", err.message);
  }
  if (err instanceof StaleTransitionError || err instanceof InvalidTransitionError) {
    return errorResponse(
      409,
      "TRANSITION_CONFLICT",
      "The RFQ could not be transitioned from its current state.",
    );
  }
  // RfqPersistenceError, TransitionPersistenceError, AuditWriteError, and
  // anything else unexpected: a real failure on our side. Logged for
  // operators, but never echoed to the client -- these messages can contain
  // raw database error text.
  console.error("RFQ API: unexpected error", err);
  return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
}

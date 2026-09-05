/**
 * Shared HTTP error-response helpers for the Approval API routes
 * (app/api/approvals/route.ts, app/api/approvals/[id]/approve/route.ts, and
 * app/api/approvals/[id]/reject/route.ts). Not a route itself -- no HTTP
 * method exports -- so Next.js's App Router does not treat this file as a
 * Route Handler.
 *
 * Extracted up front (Phase 10A), mirroring app/api/orders/error-mapping.ts
 * and app/api/quotes/error-mapping.ts exactly: all three Approval routes
 * need to map the same ApprovalApplication error types to the same
 * responses.
 */

import {
  ApprovalNotFoundError,
  ApprovalQuoteNotFoundError,
  ApprovalValidationError,
} from "../../../lib/approval/index.ts";
import { InvalidTransitionError, StaleTransitionError } from "../../../lib/state-machine/index.ts";

/** Uniform error envelope for every non-2xx response the Approval API returns. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Maps an error thrown by ApprovalApplication to a safe HTTP response.
 *
 *   400 VALIDATION_ERROR    -- ApprovalValidationError (bad input)
 *   404 QUOTE_NOT_FOUND     -- ApprovalQuoteNotFoundError (createApproval's
 *                               quoteId does not reference any Quote)
 *   404 APPROVAL_NOT_FOUND  -- ApprovalNotFoundError (getApprovalById miss,
 *                               reached by approve/reject before they
 *                               transition)
 *   409 TRANSITION_CONFLICT -- StaleTransitionError/InvalidTransitionError
 *                               (e.g. approving/rejecting an Approval that
 *                               is not currently PENDING -- both APPROVED
 *                               and REJECTED are terminal, no re-transition)
 *   500 INTERNAL_ERROR      -- ApprovalPersistenceError and anything else
 *
 * No "self-approval" or policy-bypass branch: this route layer performs no
 * such check of its own (Phase 10A: "Do not add self-approval behavior...
 * Do not bypass policy" -- there is no caller identity to compare against
 * anything yet, since no authentication/RBAC exists in this phase, and no
 * policy re-check is documented for the approve/reject step itself, only
 * for quote creation -- see lib/quote/application.ts's own policy gate,
 * unrelated to this file).
 */
export function mapApprovalErrorToResponse(err: unknown): Response {
  if (err instanceof ApprovalValidationError) {
    return errorResponse(400, "VALIDATION_ERROR", err.message, { field: err.field });
  }
  if (err instanceof ApprovalQuoteNotFoundError) {
    return errorResponse(404, "QUOTE_NOT_FOUND", err.message, { quoteId: err.quoteId });
  }
  if (err instanceof ApprovalNotFoundError) {
    return errorResponse(404, "APPROVAL_NOT_FOUND", err.message);
  }
  if (err instanceof StaleTransitionError || err instanceof InvalidTransitionError) {
    return errorResponse(
      409,
      "TRANSITION_CONFLICT",
      "The Approval could not be transitioned from its current state.",
    );
  }
  // ApprovalPersistenceError and anything wholly unexpected: a real failure
  // on our side. Logged for operators, never echoed to the client.
  console.error("Approval API: unexpected error", err);
  return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
}

/**
 * Shared HTTP error-response helpers for the Quote API routes
 * (app/api/quotes/route.ts and app/api/quotes/[id]/route.ts). Not a route
 * itself -- no HTTP method exports -- so Next.js's App Router does not treat
 * this file as a Route Handler.
 *
 * Extracted rather than duplicated because both quote routes need to map the
 * same QuoteApplication error types to the same responses -- see
 * app/api/rfqs/error-mapping.ts's mapRfqErrorToResponse() for the precedent
 * this mirrors. As in that file, QuotePersistenceError and any unanticipated
 * error are deliberately NOT instanceof-checked: both fall through to the
 * generic 500 branch, which is the only safe response for either (each can
 * carry a raw database error message that must never reach the client).
 *
 * StaleTransitionError/InvalidTransitionError (Phase 10A addition): no route
 * called QuoteApplication.transitionQuoteStatus() before Phase 10A's quote
 * acceptance endpoint (app/api/quotes/[id]/accept/route.ts), so this mapper
 * never needed a transition-conflict case. Mirrors
 * app/api/rfqs/error-mapping.ts's own 409 TRANSITION_CONFLICT branch exactly.
 */

import {
  QuoteNotFoundError,
  QuotePolicyLimitError,
  QuoteRfqNotFoundError,
  QuoteRfqStateError,
  QuoteValidationError,
} from "../../../lib/quote/index.ts";
import { InvalidTransitionError, StaleTransitionError } from "../../../lib/state-machine/index.ts";

/** Uniform error envelope for every non-2xx response the Quote API returns. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Maps an error thrown by QuoteApplication to a safe HTTP response.
 *
 *   400 VALIDATION_ERROR            -- QuoteValidationError (bad input)
 *   404 RFQ_NOT_FOUND               -- QuoteRfqNotFoundError (createQuote's
 *                                       rfqId does not reference any RFQ)
 *   404 QUOTE_NOT_FOUND             -- QuoteNotFoundError (getQuoteById miss)
 *   422 RFQ_NOT_ELIGIBLE_FOR_QUOTE  -- QuoteRfqStateError (the referenced RFQ
 *                                       exists but is in a terminal state)
 *   422 QUOTE_POLICY_LIMIT_EXCEEDED -- QuotePolicyLimitError (discount_percent
 *                                       exceeds the merchant's active policy)
 *   409 TRANSITION_CONFLICT         -- StaleTransitionError/InvalidTransitionError
 *                                       (e.g. accepting a quote that is not
 *                                       currently NEGOTIATING)
 *   500 INTERNAL_ERROR              -- QuotePersistenceError and anything else
 *
 * 422 is used for the two RFQ-state/policy checks (not 409): neither is a
 * Quote lifecycle transition conflict -- createQuote() never dispatches a
 * transition (see Phase 6). Both are business-rule failures on an otherwise
 * well-formed, syntactically valid request, the same distinction
 * app/api/rfqs/error-mapping.ts draws for RfqRequirementsParsingError -> 422.
 * 409 is reserved specifically for an actual lifecycle transition conflict
 * (Phase 10A's quote acceptance endpoint), mirroring the RFQ API's own
 * 409 TRANSITION_CONFLICT branch.
 */
export function mapQuoteErrorToResponse(err: unknown): Response {
  if (err instanceof QuoteValidationError) {
    return errorResponse(400, "VALIDATION_ERROR", err.message, { field: err.field });
  }
  if (err instanceof QuoteRfqNotFoundError) {
    return errorResponse(404, "RFQ_NOT_FOUND", err.message, { rfqId: err.rfqId });
  }
  if (err instanceof QuoteNotFoundError) {
    return errorResponse(404, "QUOTE_NOT_FOUND", err.message);
  }
  if (err instanceof QuoteRfqStateError) {
    return errorResponse(422, "RFQ_NOT_ELIGIBLE_FOR_QUOTE", err.message, {
      rfqId: err.rfqId,
      rfqStatus: err.rfqStatus,
    });
  }
  if (err instanceof QuotePolicyLimitError) {
    return errorResponse(422, "QUOTE_POLICY_LIMIT_EXCEEDED", err.message, {
      discountPercent: err.discountPercent,
      maxDiscountPercent: err.maxDiscountPercent,
    });
  }
  if (err instanceof StaleTransitionError || err instanceof InvalidTransitionError) {
    return errorResponse(
      409,
      "TRANSITION_CONFLICT",
      "The Quote could not be transitioned from its current state.",
    );
  }
  // QuotePersistenceError and anything wholly unexpected: a real failure on
  // our side. Logged for operators, never echoed to the client.
  console.error("Quote API: unexpected error", err);
  return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
}

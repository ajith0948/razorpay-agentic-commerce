/**
 * Shared HTTP error-response helpers for the Order API routes
 * (app/api/orders/route.ts and app/api/orders/[id]/route.ts). Not a route
 * itself -- no HTTP method exports -- so Next.js's App Router does not treat
 * this file as a Route Handler.
 *
 * Extracted up front (Phase 10A), mirroring app/api/quotes/error-mapping.ts
 * and app/api/rfqs/error-mapping.ts exactly: both Order routes need to map
 * the same OrderApplication error types to the same responses.
 *
 * No StaleTransitionError/InvalidTransitionError branch: unlike quote
 * acceptance, neither createOrder() nor getOrderById() ever dispatches a
 * lifecycle transition (CREATED is the schema's own default, never a
 * transition target -- lib/order/application.ts's doc comment) -- so a
 * transition-conflict response is not reachable from this API's scope
 * (Phase 10A does not expose an Order status-transition route) and is
 * deliberately not added, mirroring app/api/quotes/route.ts's own
 * (pre-Phase-10A) mapper, which omitted the same branch for the same reason.
 */

import {
  OrderAlreadyExistsError,
  OrderNotFoundError,
  OrderQuoteNotFoundError,
  OrderQuoteStateError,
  OrderValidationError,
} from "../../../lib/order/index.ts";

/** Uniform error envelope for every non-2xx response the Order API returns. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Maps an error thrown by OrderApplication to a safe HTTP response.
 *
 *   400 VALIDATION_ERROR          -- OrderValidationError (bad input)
 *   404 QUOTE_NOT_FOUND           -- OrderQuoteNotFoundError (createOrder's
 *                                     quoteId does not reference any Quote)
 *   404 ORDER_NOT_FOUND           -- OrderNotFoundError (getOrderById miss)
 *   422 QUOTE_NOT_ACCEPTED        -- OrderQuoteStateError (the referenced
 *                                     Quote exists but is not ACCEPTED)
 *   409 ORDER_ALREADY_EXISTS      -- OrderAlreadyExistsError (a duplicate
 *                                     Order for the same Quote)
 *   500 INTERNAL_ERROR            -- OrderPersistenceError and anything else
 *
 * 422 is used for the Quote-state precondition, mirroring
 * app/api/quotes/error-mapping.ts's own RFQ_NOT_ELIGIBLE_FOR_QUOTE: it is a
 * business-rule failure on an otherwise well-formed request, not a lifecycle
 * transition conflict. 409 is used for OrderAlreadyExistsError because it is,
 * literally, a resource conflict (RFC 9110: "the request could not be
 * completed due to a conflict with the current state of the target
 * resource") -- a second Order cannot coexist with the first for the same
 * Quote.
 */
export function mapOrderErrorToResponse(err: unknown): Response {
  if (err instanceof OrderValidationError) {
    return errorResponse(400, "VALIDATION_ERROR", err.message, { field: err.field });
  }
  if (err instanceof OrderQuoteNotFoundError) {
    return errorResponse(404, "QUOTE_NOT_FOUND", err.message, { quoteId: err.quoteId });
  }
  if (err instanceof OrderNotFoundError) {
    return errorResponse(404, "ORDER_NOT_FOUND", err.message);
  }
  if (err instanceof OrderQuoteStateError) {
    return errorResponse(422, "QUOTE_NOT_ACCEPTED", err.message, {
      quoteId: err.quoteId,
      quoteStatus: err.quoteStatus,
    });
  }
  if (err instanceof OrderAlreadyExistsError) {
    return errorResponse(409, "ORDER_ALREADY_EXISTS", err.message, {
      quoteId: err.quoteId,
      existingOrderId: err.existingOrderId,
    });
  }
  // OrderPersistenceError and anything wholly unexpected: a real failure on
  // our side. Logged for operators, never echoed to the client.
  console.error("Order API: unexpected error", err);
  return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
}

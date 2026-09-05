/**
 * Shared HTTP error-response helpers for the Payment API routes
 * (app/api/payments/route.ts and app/api/payments/[id]/route.ts). Not a
 * route itself -- no HTTP method exports -- so Next.js's App Router does not
 * treat this file as a Route Handler.
 *
 * Mirrors app/api/orders/error-mapping.ts exactly, including its reasoning
 * for omitting a StaleTransitionError/InvalidTransitionError branch: neither
 * createPayment() nor getPaymentById() ever dispatches a lifecycle
 * transition (CREATED is the schema's own default, never a transition
 * target -- lib/payment/application.ts's doc comment on createPayment()) --
 * so a transition-conflict response is not reachable from this API's scope
 * (Phase 10A does not expose a Payment status-transition or mark-paid
 * route) and is deliberately not added.
 */

import {
  PaymentNotFoundError,
  PaymentOrderNotFoundError,
  PaymentOrderStateError,
  PaymentValidationError,
} from "../../../lib/payment/index.ts";

/** Uniform error envelope for every non-2xx response the Payment API returns. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Maps an error thrown by PaymentApplication to a safe HTTP response.
 *
 *   400 VALIDATION_ERROR            -- PaymentValidationError (bad input)
 *   404 ORDER_NOT_FOUND             -- PaymentOrderNotFoundError (createPayment's
 *                                       orderId does not reference any Order)
 *   404 PAYMENT_NOT_FOUND           -- PaymentNotFoundError (getPaymentById miss)
 *   422 ORDER_NOT_ELIGIBLE_FOR_PAYMENT -- PaymentOrderStateError (the
 *                                       referenced Order exists but is not
 *                                       CREATED/PAYMENT_PENDING --
 *                                       PAYMENT_ELIGIBLE_ORDER_STATUSES in
 *                                       lib/payment/application.ts)
 *   500 INTERNAL_ERROR              -- PaymentPersistenceError and anything else
 *
 * 422 is used for the Order-state precondition, mirroring
 * app/api/orders/error-mapping.ts's own QUOTE_NOT_ACCEPTED: it is a
 * business-rule failure on an otherwise well-formed request against a
 * *related* entity's state, not a lifecycle transition conflict on the
 * Payment itself.
 *
 * No approval-amount-matching branch: as documented on
 * app/api/payments/route.ts, lib/payment/application.ts's createPayment()
 * has no such check to map an error from -- see that route's doc comment
 * for why this phase does not invent one.
 */
export function mapPaymentErrorToResponse(err: unknown): Response {
  if (err instanceof PaymentValidationError) {
    return errorResponse(400, "VALIDATION_ERROR", err.message, { field: err.field });
  }
  if (err instanceof PaymentOrderNotFoundError) {
    return errorResponse(404, "ORDER_NOT_FOUND", err.message, { orderId: err.orderId });
  }
  if (err instanceof PaymentNotFoundError) {
    return errorResponse(404, "PAYMENT_NOT_FOUND", err.message);
  }
  if (err instanceof PaymentOrderStateError) {
    return errorResponse(422, "ORDER_NOT_ELIGIBLE_FOR_PAYMENT", err.message, {
      orderId: err.orderId,
      orderStatus: err.orderStatus,
    });
  }
  // PaymentPersistenceError and anything wholly unexpected: a real failure
  // on our side. Logged for operators, never echoed to the client.
  console.error("Payment API: unexpected error", err);
  return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
}

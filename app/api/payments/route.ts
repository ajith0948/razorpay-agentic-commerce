/**
 * POST /api/payments -- Payment creation (Phase 10A, Step 6). Documented in
 * ARCHITECTURE.md section 24.
 *
 * ADAPTER ONLY, mirroring app/api/orders/route.ts exactly: no transition
 * table, no duplicated validation, no direct `supabase.from("payments")`
 * call, and critically -- NO Razorpay SDK import, NO call to any Razorpay
 * API, NO webhook handling. Every one of those stays exactly as absent from
 * this file as it already is from lib/payment/application.ts (see that
 * file's own doc comment):
 *
 *   POST /api/payments -> Payment Application (lib/payment) -> Runtime
 *                       (lib/runtime, not touched by this route) -> Supabase
 *
 * What this file DOES own: decoding/shape-validating the HTTP request body,
 * calling PaymentApplication.createPayment(), and translating both the
 * success result and every error the layer below can throw into a typed,
 * consistent HTTP response.
 *
 * This route does NOT accept or trust caller-supplied amount/currency/
 * quoteId -- lib/payment/application.ts's createPayment() derives every one
 * of those from the referenced Order row, and preserves the requirement
 * that the Order be payment-eligible (PaymentOrderStateError otherwise --
 * CREATED or PAYMENT_PENDING only, see PAYMENT_ELIGIBLE_ORDER_STATUSES).
 * The only caller-supplied fields are orderId (required) and the optional
 * razorpayOrderId/razorpayPaymentLinkId plumbing values -- this route never
 * calls Razorpay to obtain them, it only stores what a caller already has,
 * exactly as lib/payment/application.ts's own doc comment specifies.
 *
 * A created Payment is always status CREATED -- createPayment() does not go
 * through lib/runtime (CREATED has no incoming transition edge, it is only
 * ever the schema's own default). This route cannot and does not mark a
 * Payment PAID: reaching PAID is exclusively markPaymentPaid()'s
 * responsibility, which requires PaymentVerificationEvidence that only a
 * verified Razorpay confirmation can supply, and Phase 10A deliberately
 * does not expose a route for it (see payments/[id]/route.ts's doc comment
 * and this file's own gap note below).
 *
 * GAP -- deliberately not invented, per Phase 10A Step 6's explicit
 * instruction: this route does not check that a Payment's amount matches
 * any Approval's requestedAmount before allowing creation.
 * lib/payment/application.ts's createPayment() was inspected fresh and
 * contains no approval-amount-matching (or any other cross-entity policy)
 * check of its own -- it validates the input, checks the referenced Order
 * exists and is payment-eligible, and derives amount/currency/quoteId from
 * that Order. No such rule is documented in ARCHITECTURE.md or
 * DATABASE.md as a Payment-creation precondition. Inventing one here would
 * be exactly the kind of undocumented business rule Phase 10A instructs
 * against adding at the route layer -- reported as a gap in the final
 * report rather than implemented.
 *
 * Response shape:
 *   201 { payment: Payment }                                  -- created, status CREATED
 *   400 { error: { code: "INVALID_REQUEST_BODY"|"VALIDATION_ERROR", ... } }
 *   404 { error: { code: "ORDER_NOT_FOUND", message, orderId } }
 *   422 { error: { code: "ORDER_NOT_ELIGIBLE_FOR_PAYMENT", message, orderId, orderStatus } }
 *   500 { error: { code: "INTERNAL_ERROR", message } }
 */

import { z } from "zod";
import {
  createSupabasePaymentApplication,
  type PaymentApplication,
} from "../../../lib/payment/index.ts";
import { errorResponse, mapPaymentErrorToResponse } from "./error-mapping.ts";

/**
 * HTTP-shape validation only -- type and presence, not content. Field set
 * matches CreatePaymentInput (lib/payment/types.ts) exactly: orderId plus
 * the two optional Razorpay plumbing ids. amount/currency/quoteId are
 * deliberately absent -- the application layer derives them from the
 * referenced Order, never caller input.
 */
const CreatePaymentRequestSchema = z.object({
  orderId: z.string().uuid(),
  razorpayOrderId: z.string().nullable().optional(),
  razorpayPaymentLinkId: z.string().nullable().optional(),
});

/**
 * The route's real logic, factored out from POST() so it can be unit tested
 * against a fake PaymentApplication with no live Supabase connection (see
 * route.test.ts). POST() below is a thin per-request wrapper -- it
 * constructs createSupabasePaymentApplication() fresh on every call rather
 * than once at module scope, matching every other route in this project.
 */
export async function handleCreatePayment(
  app: PaymentApplication,
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body must be valid JSON.");
  }

  const parsedBody = CreatePaymentRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body failed validation.", {
      details: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const payment = await app.createPayment(parsedBody.data);
    return Response.json({ payment }, { status: 201 });
  } catch (err) {
    return mapPaymentErrorToResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleCreatePayment(createSupabasePaymentApplication(), request);
}

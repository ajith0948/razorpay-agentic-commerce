/**
 * GET /api/payments/:id -- Payment retrieval (Phase 10A, Step 6). Documented
 * in ARCHITECTURE.md section 24.
 *
 * ADAPTER ONLY, same discipline as app/api/orders/[id]/route.ts: this file
 * decodes the dynamic route segment and translates
 * PaymentApplication.getPaymentById()'s result/errors into an HTTP
 * response. No database access, no business logic, no Razorpay call of any
 * kind -- this is a plain read of the row already stored.
 *
 * Response shape:
 *   200 { payment: Payment }
 *   404 { error: { code: "PAYMENT_NOT_FOUND", message } }
 *   500 { error: { code: "INTERNAL_ERROR", message } }
 *
 * No 400 case: the dynamic segment cannot be empty (Next.js does not match
 * `/api/payments/[id]` for an empty segment), and ids are opaque strings to
 * this layer.
 */

import {
  createSupabasePaymentApplication,
  type PaymentApplication,
} from "../../../../lib/payment/index.ts";
import { errorResponse, mapPaymentErrorToResponse } from "../error-mapping.ts";
import { z } from "zod";

/**
 * The route's real logic, factored out from GET() so it can be unit tested
 * against a fake PaymentApplication with no live Supabase connection (see
 * payment-id-route.test.ts, one directory up -- same bracket-glob reasoning
 * as app/api/quotes/quote-id-route.test.ts).
 */
export async function handleGetPayment(
  app: PaymentApplication,
  paymentId: string,
): Promise<Response> {
  try {
    const payment = await app.getPaymentById(paymentId);
    return Response.json({ payment }, { status: 200 });
  } catch (err) {
    return mapPaymentErrorToResponse(err);
  }
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return errorResponse(400, "VALIDATION_ERROR", "Payment ID must be a valid UUID.");
  }
  return handleGetPayment(createSupabasePaymentApplication(), parsedId.data);
}

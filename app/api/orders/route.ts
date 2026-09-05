/**
 * POST /api/orders -- Order creation (Phase 10A, Step 2). Documented in
 * ARCHITECTURE.md section 24 ("The exact route naming can be adjusted during
 * implementation while preserving the architecture and responsibilities").
 *
 * ADAPTER ONLY, mirroring app/api/quotes/route.ts exactly: no transition
 * table, no duplicated validation, no direct `supabase.from("orders")` call
 * -- every one of those already lives in lib/order:
 *
 *   POST /api/orders -> Order Application (lib/order) -> Runtime Boundary
 *                     (lib/runtime, not touched by this route) -> Supabase
 *
 * What this file DOES own: decoding/shape-validating the HTTP request body,
 * calling OrderApplication.createOrder(), and translating both the success
 * result and every error the layer below can throw into a typed, consistent
 * HTTP response.
 *
 * This route does NOT accept or trust caller-supplied merchantId/buyerId/
 * rfqId/amount/currency -- lib/order/application.ts's createOrder() derives
 * every one of those from the referenced Quote row, and preserves the
 * requirement that the Quote be ACCEPTED (OrderQuoteStateError otherwise)
 * and that no duplicate Order already exists for it
 * (OrderAlreadyExistsError otherwise). Creating an Order is deliberately a
 * separate call from quote acceptance
 * (app/api/quotes/[id]/accept/route.ts) -- Phase 10A Step 2 requires this
 * route not be triggered automatically by that one.
 *
 * Response shape:
 *   201 { order: Order }                                     -- created
 *   400 { error: { code: "INVALID_REQUEST_BODY"|"VALIDATION_ERROR", ... } }
 *   404 { error: { code: "QUOTE_NOT_FOUND", message, quoteId } }
 *   422 { error: { code: "QUOTE_NOT_ACCEPTED", message, quoteId, quoteStatus } }
 *   409 { error: { code: "ORDER_ALREADY_EXISTS", message, quoteId, existingOrderId } }
 *   500 { error: { code: "INTERNAL_ERROR", message } }
 */

import { z } from "zod";
import {
  createSupabaseOrderApplication,
  type OrderApplication,
} from "../../../lib/order/index.ts";
import { errorResponse, mapOrderErrorToResponse } from "./error-mapping.ts";

/**
 * HTTP-shape validation only -- type and presence, not content. Field set
 * matches CreateOrderInput (lib/order/types.ts) exactly: quoteId is the only
 * accepted field, every other Order field is derived from the referenced
 * Quote by the application layer, never caller input.
 */
const CreateOrderRequestSchema = z.object({
  quoteId: z.string().uuid(),
});

/**
 * The route's real logic, factored out from POST() so it can be unit tested
 * against a fake OrderApplication with no live Supabase connection (see
 * route.test.ts). POST() below is a thin per-request wrapper -- it
 * constructs createSupabaseOrderApplication() fresh on every call rather
 * than once at module scope, matching every other route in this project.
 */
export async function handleCreateOrder(
  app: OrderApplication,
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body must be valid JSON.");
  }

  const parsedBody = CreateOrderRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body failed validation.", {
      details: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const order = await app.createOrder(parsedBody.data);
    return Response.json({ order }, { status: 201 });
  } catch (err) {
    return mapOrderErrorToResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateOrder(createSupabaseOrderApplication(), request);
}

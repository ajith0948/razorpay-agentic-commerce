/**
 * GET /api/orders/:id -- Order retrieval (Phase 10A, Step 4). Documented in
 * ARCHITECTURE.md section 24.
 *
 * ADAPTER ONLY, same discipline as app/api/quotes/[id]/route.ts: this file
 * decodes the dynamic route segment and translates
 * OrderApplication.getOrderById()'s result/errors into an HTTP response. No
 * database access, no business logic.
 *
 * Response shape:
 *   200 { order: Order }
 *   404 { error: { code: "ORDER_NOT_FOUND", message } }
 *   500 { error: { code: "INTERNAL_ERROR", message } }
 *
 * No 400 case: the dynamic segment cannot be empty (Next.js does not match
 * `/api/orders/[id]` for an empty segment), and ids are opaque strings to
 * this layer.
 */

import {
  createSupabaseOrderApplication,
  type OrderApplication,
} from "../../../../lib/order/index.ts";
import { errorResponse, mapOrderErrorToResponse } from "../error-mapping.ts";
import { z } from "zod";

/**
 * The route's real logic, factored out from GET() so it can be unit tested
 * against a fake OrderApplication with no live Supabase connection (see
 * order-id-route.test.ts, one directory up -- same bracket-glob reasoning as
 * app/api/quotes/quote-id-route.test.ts).
 */
export async function handleGetOrder(app: OrderApplication, orderId: string): Promise<Response> {
  try {
    const order = await app.getOrderById(orderId);
    return Response.json({ order }, { status: 200 });
  } catch (err) {
    return mapOrderErrorToResponse(err);
  }
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return errorResponse(400, "VALIDATION_ERROR", "Order ID must be a valid UUID.");
  }
  return handleGetOrder(createSupabaseOrderApplication(), parsedId.data);
}

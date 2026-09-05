/**
 * GET /api/rfqs/:id -- RFQ retrieval (Phase 10A, Step 3). Documented in
 * ARCHITECTURE.md section 24.
 *
 * ADAPTER ONLY, same discipline as app/api/quotes/[id]/route.ts: this file
 * decodes the dynamic route segment and translates
 * RfqApplication.getRfqById()'s result/errors into an HTTP response. No
 * database access, no business logic.
 *
 * Response shape:
 *   200 { rfq: Rfq }
 *   404 { error: { code: "RFQ_NOT_FOUND", message } }
 *   500 { error: { code: "INTERNAL_ERROR", message } }  -- message is always
 *                                                           the same safe
 *                                                           string, never a
 *                                                           raw database error
 *
 * No 400 case: the dynamic segment cannot be empty (Next.js does not match
 * `/api/rfqs/[id]` for an empty segment), and lib/rfq/db.ts's id lookup has
 * no format constraint of its own to duplicate here (ids are opaque strings
 * to this layer, just as app/api/quotes/[id]/route.ts's own id handling
 * assumes).
 */

import { createSupabaseRfqApplication, type RfqApplication } from "../../../../lib/rfq/index.ts";
import { errorResponse, mapRfqErrorToResponse } from "../error-mapping.ts";
import { z } from "zod";

/**
 * The route's real logic, factored out from GET() so it can be unit tested
 * against a fake RfqApplication with no live Supabase connection (see
 * rfq-id-route.test.ts, one directory up -- same bracket-glob reasoning as
 * app/api/quotes/quote-id-route.test.ts) -- same split as
 * handleGetQuote()/handleCreateRfq().
 */
export async function handleGetRfq(app: RfqApplication, rfqId: string): Promise<Response> {
  try {
    const rfq = await app.getRfqById(rfqId);
    return Response.json({ rfq }, { status: 200 });
  } catch (err) {
    return mapRfqErrorToResponse(err);
  }
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return errorResponse(400, "VALIDATION_ERROR", "RFQ ID must be a valid UUID.");
  }
  return handleGetRfq(createSupabaseRfqApplication(), parsedId.data);
}

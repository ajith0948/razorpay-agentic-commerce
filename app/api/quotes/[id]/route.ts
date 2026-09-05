/**
 * GET /api/quotes/:id -- Quote retrieval (Phase 7, Step 2/4). Documented in
 * ARCHITECTURE.md section 24.
 *
 * ADAPTER ONLY, same discipline as app/api/quotes/route.ts and
 * app/api/rfqs/route.ts: this file decodes the dynamic route segment and
 * translates QuoteApplication.getQuoteById()'s result/errors into an HTTP
 * response. No database access, no business logic.
 *
 * Response shape:
 *   200 { quote: Quote }
 *   404 { error: { code: "QUOTE_NOT_FOUND", message } }
 *   500 { error: { code: "INTERNAL_ERROR", message } }  -- message is always
 *                                                           the same safe
 *                                                           string, never a
 *                                                           raw database error
 *
 * No 400 case: the dynamic segment cannot be empty (Next.js does not match
 * `/api/quotes/[id]` for an empty segment), and lib/quote/db.ts's id lookup
 * has no format constraint of its own to duplicate here (ids are opaque
 * strings to this layer, just as app/api/rfqs/route.ts's own id handling
 * assumes).
 */

import { createSupabaseQuoteApplication, type QuoteApplication } from "../../../../lib/quote/index.ts";
import { errorResponse, mapQuoteErrorToResponse } from "../error-mapping.ts";
import { z } from "zod";

/**
 * The route's real logic, factored out from GET() so it can be unit tested
 * against a fake QuoteApplication with no live Supabase connection (see
 * route.test.ts) -- same split as handleCreateQuote()/handleCreateRfq().
 */
export async function handleGetQuote(app: QuoteApplication, quoteId: string): Promise<Response> {
  try {
    const quote = await app.getQuoteById(quoteId);
    return Response.json({ quote }, { status: 200 });
  } catch (err) {
    return mapQuoteErrorToResponse(err);
  }
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return errorResponse(400, "VALIDATION_ERROR", "Quote ID must be a valid UUID.");
  }
  return handleGetQuote(createSupabaseQuoteApplication(), parsedId.data);
}

/**
 * POST /api/quotes -- the Quote creation HTTP API (Phase 7, Step 2/3).
 * Documented in ARCHITECTURE.md section 24.
 *
 * This file is an ADAPTER ONLY, mirroring app/api/rfqs/route.ts exactly: no
 * transition table, no duplicated validation, no direct
 * `supabase.from("quotes")` call, no RFQ-eligibility or merchant-policy
 * logic of its own -- every one of those already lives in lib/quote
 * (Phase 6):
 *
 *   POST /api/quotes -> Quote Application (lib/quote) -> Runtime Boundary
 *                     (lib/runtime, not touched by this route) -> Supabase
 *
 * What this file DOES own: decoding/shape-validating the HTTP request body,
 * calling QuoteApplication.createQuote(), and translating both the success
 * result and every error the layers below can throw into a typed, consistent
 * HTTP response -- never a raw Supabase/Postgres error string, never a stack
 * trace.
 *
 * Creating a Quote is NOT a lifecycle transition (Phase 6: DRAFT is the
 * column's own default, never a transition target) -- this route does not
 * call transitionQuoteStatus(), and the created Quote's status is always
 * DRAFT in the 201 response. It also never touches the referenced RFQ's own
 * status: lib/quote/application.ts's createQuote() only *reads* the RFQ to
 * validate the reference and derive merchant_id/buyer_id (Phase 6); no
 * documented rule in DATABASE.md/ARCHITECTURE.md/IMPLEMENTATION_PLAN.md ties
 * Quote creation (or any other Quote state) to an RFQ status change, so none
 * is performed here -- see this phase's architectural assessment for the
 * search that confirmed this gap.
 *
 * Response shape:
 *   201 { quote: Quote }                                  -- created, status DRAFT
 *   400 { error: { code: "INVALID_REQUEST_BODY", ... } }  -- bad JSON / failed shape validation
 *   400 { error: { code: "VALIDATION_ERROR", ... } }      -- lib/quote business validation
 *   404 { error: { code: "RFQ_NOT_FOUND", ... } }         -- rfqId does not reference an RFQ
 *   422 { error: { code: "RFQ_NOT_ELIGIBLE_FOR_QUOTE", .. } } -- referenced RFQ is terminal
 *   422 { error: { code: "QUOTE_POLICY_LIMIT_EXCEEDED", .. } } -- discount exceeds merchant policy
 *   500 { error: { code: "INTERNAL_ERROR", message } }    -- persistence/internal failure;
 *                                                             message is always the same
 *                                                             safe string, never err.message
 *
 * Two-layer, non-overlapping validation, same split as app/api/rfqs/route.ts:
 *   1. HTTP shape (Zod, here): are the right keys present with the right
 *      JSON types? Does not check content (non-empty, ranges, RFQ
 *      existence), so it never duplicates layer 2's job.
 *   2. Business rules (lib/quote, unchanged): non-empty strings, numeric
 *      ranges, RFQ existence/eligibility, merchant policy limits.
 */

import { z } from "zod";
import {
  createSupabaseQuoteApplication,
  type QuoteApplication,
} from "../../../lib/quote/index.ts";
import { errorResponse, mapQuoteErrorToResponse } from "./error-mapping.ts";

/**
 * HTTP-shape validation only -- type and presence, not content. `.string()`
 * without `.min(1)` deliberately: an empty string is a well-formed JSON
 * string, so rejecting it is validateCreateQuoteInput's job (layer 2), not
 * this schema's. Extra/unrecognized keys are silently stripped (Zod's
 * z.object() default). Field set matches CreateQuoteInput (lib/quote/types.ts)
 * exactly -- merchantId/buyerId/status are not accepted here for the same
 * reason lib/quote/types.ts's own doc comment excludes them from
 * CreateQuoteInput: they are derived from the referenced RFQ, never caller
 * input.
 */
const CreateQuoteRequestSchema = z.object({
  rfqId: z.string(),
  totalAmount: z.number(),
  currency: z.string(),
  discountPercent: z.number().optional(),
  deliveryDays: z.number(),
  deliveryLocation: z.string(),
  validUntil: z.string().nullable().optional(),
});

/**
 * The route's real logic, factored out from POST() so it can be unit tested
 * against a fake QuoteApplication with no live Supabase connection (see
 * route.test.ts). POST() below is a thin per-request wrapper -- it
 * constructs createSupabaseQuoteApplication() fresh on every call rather
 * than once at module scope, matching lib/quote/application.ts's own "no
 * module-level client" convention.
 */
export async function handleCreateQuote(
  app: QuoteApplication,
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body must be valid JSON.");
  }

  const parsedBody = CreateQuoteRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body failed validation.", {
      details: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const quote = await app.createQuote(parsedBody.data);
    return Response.json({ quote }, { status: 201 });
  } catch (err) {
    return mapQuoteErrorToResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateQuote(createSupabaseQuoteApplication(), request);
}

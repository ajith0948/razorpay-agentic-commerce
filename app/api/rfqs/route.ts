/**
 * POST /api/rfqs -- the RFQ HTTP API (Phase 5, Step 2). The only route in
 * this file, and the first Route Handler in the project (Next.js App
 * Router "Route Handlers" convention -- node_modules/next/dist/docs/01-app/
 * 01-getting-started/15-route-handlers.md -- plain Web Request/Response,
 * no NextRequest/NextResponse needed for a route this simple).
 *
 * This file is an ADAPTER ONLY. It has no transition table of its own, no
 * duplicated business logic, no direct `supabase.from("rfqs").update(...)`
 * call, and no parsing logic -- every one of those already lives at the
 * layer that owns it:
 *
 *   POST /api/rfqs -> RFQ Application (lib/rfq) -> Requirements Parser
 *                   -> Runtime Boundary (lib/runtime)
 *                   -> State Machine (lib/state-machine) -> Supabase
 *
 * What this file DOES own: decoding/shape-validating the HTTP request body,
 * calling the two RfqApplication methods in the sequence this capability
 * needs (create, then process), and translating both the success result and
 * every error the layers below can throw into a typed, consistent HTTP
 * response -- never a raw Supabase/Postgres error string, never a stack
 * trace, never service-role credentials.
 *
 * Orchestration shape: createRfq() then processRfqRequirements() run
 * sequentially, synchronously within this one request/response cycle --
 * not a combined RfqApplication method of their own (that would move
 * request-flow decisions into the domain layer, which is not this route's
 * to decide) and not a background job (nothing in this phase's scope
 * establishes an async job queue). A client that only wants the RFQ
 * created without immediate parsing has no use case in this phase (Step 4
 * requires "RFQ lifecycle progression into PROCESSING" as part of what
 * this capability delivers), so there is no separate endpoint to skip the
 * second step.
 *
 * Response shape:
 *   201 { rfq: Rfq }                                     -- created and processed
 *   422 { error: { code: "RFQ_REQUIREMENTS_INCOMPLETE",
 *                  message, rfqId, missingFields } }     -- created, but raw_request
 *                                                            could not be parsed
 *   400 { error: { code, message, details?/field? } }    -- bad JSON / failed
 *                                                            shape or business
 *                                                            validation
 *   404 { error: { code: "RFQ_NOT_FOUND", message } }    -- defensive; see
 *                                                            mapRfqErrorToResponse
 *   409 { error: { code: "TRANSITION_CONFLICT", message } } -- stale/invalid edge
 *   500 { error: { code: "INTERNAL_ERROR", message } }   -- persistence/audit
 *                                                            failure; message is
 *                                                            always the same safe
 *                                                            string, never err.message
 *
 * Three-layer, non-overlapping validation (see CreateRfqRequestSchema and
 * lib/rfq/application.ts's validateCreateRfqInput):
 *   1. HTTP shape (Zod, here): are the right keys present with the right
 *      JSON types? Does not check content (e.g. non-empty), so it never
 *      duplicates layer 2's job.
 *   2. Business rules (lib/rfq, unchanged): non-empty strings, expiresAt
 *      must be a valid future date.
 *   3. Parser output contract (Zod, requirements-parser.ts): unrelated to
 *      this route -- enforced entirely inside processRfqRequirements().
 */

import { z } from "zod";
import {
  createSupabaseRfqApplication,
  RfqRequirementsParsingError,
  type RfqApplication,
} from "../../../lib/rfq/index.ts";
import { errorResponse, mapRfqErrorToResponse } from "./error-mapping.ts";

/**
 * HTTP-shape validation only -- type and presence, not content. `.string()`
 * without `.min(1)` deliberately: an empty string is a well-formed JSON
 * string, so rejecting it is validateCreateRfqInput's job (layer 2), not
 * this schema's. Extra/unrecognized keys are silently stripped (Zod's
 * z.object() default), not an error -- a forward-compatible client sending
 * a field this phase does not yet use should not get a 400 for it.
 */
const CreateRfqRequestSchema = z.object({
  merchantId: z.string(),
  buyerId: z.string(),
  rawRequest: z.string(),
  expiresAt: z.string().nullable().optional(),
});

/**
 * The route's real logic, factored out from POST() so it can be unit
 * tested against a fake RfqApplication with no live Supabase connection
 * (see route.test.ts). POST() below is a thin per-request wrapper -- it
 * constructs createSupabaseRfqApplication() fresh on every call rather than
 * once at module scope, matching lib/runtime/state-runtime.ts's and
 * lib/rfq/application.ts's own "no module-level client" convention (a
 * module-scoped call would also throw at import time -- and so at `next
 * build` time -- if Supabase env vars are not set).
 */
export async function handleCreateRfq(app: RfqApplication, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body must be valid JSON.");
  }

  const parsedBody = CreateRfqRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body failed validation.", {
      details: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  let rfqId: string;
  try {
    const rfq = await app.createRfq(parsedBody.data);
    rfqId = rfq.id;
  } catch (err) {
    return mapRfqErrorToResponse(err);
  }

  try {
    const processed = await app.processRfqRequirements(rfqId);
    return Response.json({ rfq: processed }, { status: 201 });
  } catch (err) {
    if (err instanceof RfqRequirementsParsingError) {
      return errorResponse(422, "RFQ_REQUIREMENTS_INCOMPLETE", err.message, {
        rfqId,
        missingFields: err.missingFields,
      });
    }
    return mapRfqErrorToResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateRfq(createSupabaseRfqApplication(), request);
}

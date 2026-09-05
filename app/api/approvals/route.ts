/**
 * POST /api/approvals -- Approval request creation (Phase 10A, Step 5).
 * Documented in ARCHITECTURE.md section 24.
 *
 * ADAPTER ONLY, mirroring app/api/orders/route.ts exactly: no transition
 * table, no duplicated validation, no direct `supabase.from("approvals")`
 * call --
 *
 *   POST /api/approvals -> Approval Application (lib/approval) -> Runtime
 *                        Boundary (lib/runtime, not touched by this route
 *                        for creation) -> Supabase
 *
 * This route calls ONLY ApprovalApplication.createApproval(). The created
 * Approval's status is always PENDING (createApproval() never dispatches a
 * transition -- lib/approval/application.ts's own doc comment: PENDING is
 * the schema's own default, not a transition target). merchantId/rfqId/
 * requestedAmount are never caller-supplied; they are derived from the
 * referenced Quote by the application layer.
 *
 * Response shape:
 *   201 { approval: Approval }                                -- created, status PENDING
 *   400 { error: { code: "INVALID_REQUEST_BODY"|"VALIDATION_ERROR", ... } }
 *   404 { error: { code: "QUOTE_NOT_FOUND", message, quoteId } }
 *   500 { error: { code: "INTERNAL_ERROR", message } }
 */

import { z } from "zod";
import {
  createSupabaseApprovalApplication,
  type ApprovalApplication,
} from "../../../lib/approval/index.ts";
import { errorResponse, mapApprovalErrorToResponse } from "./error-mapping.ts";

/**
 * HTTP-shape validation only -- type and presence, not content. Field set
 * matches CreateApprovalInput (lib/approval/types.ts) exactly: quoteId and
 * reason are the only accepted fields, every other Approval field is
 * derived from the referenced Quote by the application layer.
 */
const CreateApprovalRequestSchema = z.object({
  quoteId: z.string(),
  reason: z.string(),
});

/**
 * The route's real logic, factored out from POST() so it can be unit tested
 * against a fake ApprovalApplication with no live Supabase connection (see
 * route.test.ts).
 */
export async function handleCreateApproval(
  app: ApprovalApplication,
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body must be valid JSON.");
  }

  const parsedBody = CreateApprovalRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body failed validation.", {
      details: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const approval = await app.createApproval(parsedBody.data);
    return Response.json({ approval }, { status: 201 });
  } catch (err) {
    return mapApprovalErrorToResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateApproval(createSupabaseApprovalApplication(), request);
}

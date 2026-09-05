/**
 * Shared logic behind POST /api/approvals/:id/approve and POST
 * /api/approvals/:id/reject (Phase 10A, Step 5). Not a route itself -- no
 * HTTP method exports -- so Next.js's App Router does not treat this file as
 * a Route Handler. Factored out because both routes are the same operation
 * (read the current Approval, then transition it) with only the target
 * status differing, mirroring how app/api/rfqs/route.ts factors
 * create-then-process into one sequential flow rather than duplicating it.
 *
 * Both routes call ONLY ApprovalApplication.getApprovalById() (to discover
 * the current status/merchantId/rfqId/quoteId) then
 * transitionApprovalStatus(). `actorType` is fixed to "HUMAN_MERCHANT",
 * never caller-supplied -- ARCHITECTURE.md section 25's "AI Request Flow"
 * step 16 ("Human approves when necessary") is the documented actor for
 * this decision, and lib/state-machine/approval.ts's transitionApproval()
 * already stamps approved_by/approved_at for BOTH the APPROVED and REJECTED
 * outcomes, confirming a human decision-maker is expected for either
 * outcome, not only approval.
 *
 * `approvedBy` is accepted as an optional free-text request-body field
 * (who made the decision) and passed straight through to
 * transitionApprovalStatus() -- an already-existing optional field on its
 * contract, not a new one invented by this route. This is deliberately NOT
 * authentication/RBAC (Phase 10A: "Do not invent authentication/RBAC yet"):
 * the value is stored as-supplied, with no verification, lookup, or
 * authorization decision made from it. Its absence is not an error --
 * `approved_by` simply stays null, exactly as it would if nothing ever
 * called transitionApprovalStatus() with one.
 *
 * No self-approval or policy-bypass logic is added here (Phase 10A: "Do not
 * add self-approval behavior... Do not bypass policy") -- there is nothing
 * for this layer to check: no caller identity exists yet to compare against
 * a requester, and no additional policy re-check is documented for this
 * step (see error-mapping.ts's own doc comment).
 */

import { z } from "zod";
import type { ApprovalApplication } from "../../../lib/approval/index.ts";
import { errorResponse, mapApprovalErrorToResponse } from "./error-mapping.ts";

const DecisionRequestSchema = z.object({
  approvedBy: z.string().optional(),
});

/**
 * Parses an optional JSON body of the form `{approvedBy?: string}`.
 * Tolerates a genuinely empty body (no client-supplied decision-maker is a
 * valid request, not a validation failure) but rejects a non-empty body
 * that is not valid JSON or does not match the schema.
 */
async function parseOptionalApprovedBy(
  request: Request,
): Promise<{ ok: true; approvedBy?: string } | { ok: false; response: Response }> {
  const rawBody = await request.text();
  if (rawBody.trim() === "") {
    return { ok: true };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      response: errorResponse(400, "INVALID_REQUEST_BODY", "Request body must be valid JSON."),
    };
  }

  const parsedBody = DecisionRequestSchema.safeParse(parsedJson);
  if (!parsedBody.success) {
    return {
      ok: false,
      response: errorResponse(400, "INVALID_REQUEST_BODY", "Request body failed validation.", {
        details: parsedBody.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      }),
    };
  }

  return { ok: true, approvedBy: parsedBody.data.approvedBy };
}

/**
 * The route logic shared by handleApproveApproval() and
 * handleRejectApproval() below -- exported so each route's own test file
 * can still exercise its own thin POST() wrapper independently, while the
 * behavior itself is defined exactly once.
 */
export async function handleApprovalDecision(
  app: ApprovalApplication,
  approvalId: string,
  request: Request,
  to: "APPROVED" | "REJECTED",
): Promise<Response> {
  const parsed = await parseOptionalApprovedBy(request);
  if (!parsed.ok) {
    return parsed.response;
  }

  try {
    const current = await app.getApprovalById(approvalId);
    const decided = await app.transitionApprovalStatus({
      approvalId,
      from: current.status,
      to,
      merchantId: current.merchantId,
      rfqId: current.rfqId,
      quoteId: current.quoteId,
      actorType: "HUMAN_MERCHANT",
      approvedBy: parsed.approvedBy,
    });
    return Response.json({ approval: decided }, { status: 200 });
  } catch (err) {
    return mapApprovalErrorToResponse(err);
  }
}

/**
 * POST /api/approvals/:id/reject -- Approval decision: reject (Phase 10A,
 * Step 5). Documented in ARCHITECTURE.md section 24.
 *
 * ADAPTER ONLY. All real logic lives in app/api/approvals/decision.ts's
 * handleApprovalDecision(), shared with the /approve route -- see that
 * file's doc comment for the full behavior (actorType fixing, optional
 * approvedBy passthrough, why no self-approval/policy logic is added here).
 *
 *   POST /api/approvals/:id/reject -> Approval Application (lib/approval)
 *                                   -> Runtime Boundary (lib/runtime)
 *                                   -> State Machine (lib/state-machine) -> Supabase
 *
 * Response shape:
 *   200 { approval: Approval }                                -- now REJECTED
 *   400 { error: { code: "INVALID_REQUEST_BODY", ... } }      -- malformed optional body
 *   404 { error: { code: "APPROVAL_NOT_FOUND", message } }
 *   409 { error: { code: "TRANSITION_CONFLICT", message } }  -- Approval is
 *                                                                not currently
 *                                                                PENDING
 *   500 { error: { code: "INTERNAL_ERROR", message } }
 */

import {
  createSupabaseApprovalApplication,
  type ApprovalApplication,
} from "../../../../../lib/approval/index.ts";
import { handleApprovalDecision } from "../../decision.ts";

/**
 * Factored out from POST() so it can be unit tested against a fake
 * ApprovalApplication with no live Supabase connection (see
 * approval-reject-route.test.ts, one directory up -- same bracket-glob
 * reasoning as app/api/quotes/quote-id-route.test.ts).
 */
export async function handleRejectApproval(
  app: ApprovalApplication,
  approvalId: string,
  request: Request,
): Promise<Response> {
  return handleApprovalDecision(app, approvalId, request, "REJECTED");
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  return handleRejectApproval(createSupabaseApprovalApplication(), id, request);
}

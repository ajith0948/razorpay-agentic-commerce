/**
 * Approval state machine -- DATABASE.md section 12.
 *
 * PENDING -> APPROVED and PENDING -> REJECTED are the only edges; both are
 * terminal. A human decision, once made, is not revisable through this
 * module (there is no APPROVED/REJECTED -> anything edge) -- a merchant who
 * changes their mind creates a new Approval row rather than mutating a
 * settled one, matching how Order/Payment retries also create new rows
 * rather than reversing a settled status (see order.ts, payment.ts).
 */

import { assertValidTransition, type TransitionTable } from "./transition-table.ts";
import { applyStatusTransition, type StatusDbClient } from "./db.ts";
import { recordAuditEvent } from "./audit.ts";
import type { ApprovalStatus, AuditActorType } from "./types.ts";

export const APPROVAL_TRANSITIONS: TransitionTable<ApprovalStatus> = {
  PENDING: ["APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

/** event_type per edge, per ARCHITECTURE.md section 21's example list. */
function approvalEventType(to: ApprovalStatus): string {
  if (to === "APPROVED") return "APPROVAL_GRANTED";
  return "APPROVAL_STATUS_CHANGED";
}

export interface TransitionApprovalParams {
  client: StatusDbClient;
  approvalId: string;
  from: ApprovalStatus;
  to: ApprovalStatus;
  /** Required: audit_events.merchant_id is NOT NULL. */
  merchantId: string;
  actorType: AuditActorType;
  rfqId?: string | null;
  quoteId?: string | null;
  /**
   * Free-text identifier of the human who resolved this approval --
   * approvals.approved_by is a nullable free-text column, not a foreign
   * key (DATABASE.md section 12; the schema models no individual
   * merchant-side human, only the Merchant business itself, and the MVP has
   * no real authentication -- AGENTS.md section 10), so this is stored
   * as-is rather than validated against another table. Recorded for both
   * APPROVED and REJECTED outcomes: the column pair (approved_by,
   * approved_at) is the only "who/when resolved this" record the schema
   * has, so leaving it null on a rejection would erase who made that call.
   */
  approvedBy?: string | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
  policyResult?: string | null;
}

/**
 * The only way application code may resolve an Approval. Stamps
 * approved_by/approved_at in the same update as the status change, for
 * either outcome (see the approvedBy param doc above).
 */
export async function transitionApproval(params: TransitionApprovalParams): Promise<void> {
  const {
    client,
    approvalId,
    from,
    to,
    merchantId,
    actorType,
    rfqId,
    quoteId,
    approvedBy,
    inputSummary,
    outputSummary,
    policyResult,
  } = params;

  assertValidTransition("Approval", APPROVAL_TRANSITIONS, from, to);

  await applyStatusTransition({
    client,
    table: "approvals",
    id: approvalId,
    from,
    to,
    extraPatch: {
      approved_by: approvedBy ?? null,
      approved_at: new Date().toISOString(),
    },
  });

  await recordAuditEvent(client, {
    merchantId,
    rfqId,
    quoteId,
    eventType: approvalEventType(to),
    actorType,
    action: `Approval status changed: ${from} -> ${to}`,
    inputSummary,
    outputSummary,
    policyResult,
  });
}

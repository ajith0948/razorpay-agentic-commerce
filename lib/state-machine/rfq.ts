/**
 * RFQ (Request for Quote) state machine -- DATABASE.md section 9.
 *
 * CREATED -> PROCESSING -> QUOTED -> ACCEPTED is the direct success path
 * when a quote is accepted without negotiation (the agent flow). When
 * negotiation does occur, QUOTED -> NEGOTIATING -> ACCEPTED is equally
 * valid. ACCEPTED is terminal. Once a quote is accepted the RFQ's job is
 * done -- the Order/Payment lifecycle (order.ts, payment.ts) then handles
 * financial execution entirely on its own. That independence (section 9's
 * own rule, restated in section 14) is enforced structurally here, not just
 * by convention: this file never reads or writes orders.status or
 * payments.status, and nothing in order.ts/payment.ts reads or writes
 * rfqs.status.
 *
 * This module also deliberately does NOT verify that a linked Quote is
 * itself ACCEPTED before allowing QUOTED/NEGOTIATING -> ACCEPTED here.
 * Unlike the Order/Payment relationship, no requirement in this phase's
 * task asked for that cross-check, and DATABASE.md section 9 frames quote
 * acceptance as driving RFQ acceptance ("once a quote is accepted, the
 * RFQ's job is done"), i.e. something in a later orchestration phase calls
 * transitionQuote(...ACCEPTED) and transitionRfq(...ACCEPTED) together --
 * this module does not need to re-derive that ordering by reading quotes.
 */

import { assertValidTransition, type TransitionTable } from "./transition-table.ts";
import { applyStatusTransition, type StatusDbClient } from "./db.ts";
import { recordAuditEvent } from "./audit.ts";
import type { AuditActorType, RfqStatus } from "./types.ts";

export const RFQ_TRANSITIONS: TransitionTable<RfqStatus> = {
  CREATED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["QUOTED", "FAILED", "CANCELLED"],
  QUOTED: ["NEGOTIATING", "ACCEPTED", "EXPIRED", "CANCELLED"],
  NEGOTIATING: ["ACCEPTED", "REJECTED", "CANCELLED"],
  // Terminal states. REJECTED/EXPIRED/CANCELLED having no outgoing edges is
  // what guarantees "a rejected/expired/cancelled RFQ cannot become
  // accepted" -- there is simply no edge from any of them to ACCEPTED (or
  // anywhere else).
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
};

export interface TransitionRfqParams {
  client: StatusDbClient;
  rfqId: string;
  from: RfqStatus;
  to: RfqStatus;
  /** Required: audit_events.merchant_id is NOT NULL. */
  merchantId: string;
  actorType: AuditActorType;
  buyerId?: string | null;
  agentSessionId?: string | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
  policyResult?: string | null;
  /**
   * When provided, written to rfqs.structured_requirements in the exact
   * same compare-and-swap UPDATE as the status change (via
   * applyStatusTransition's extraPatch -- the same mechanism approval.ts
   * already uses for approved_by/approved_at, agent-session.ts for
   * ended_at). This is what lets a later phase's requirements-parsing step
   * persist its output atomically with the CREATED -> PROCESSING edge: there
   * is no window where the database could show PROCESSING with
   * structured_requirements still null, or vice versa. Omitted (left
   * undefined) on every other edge, exactly like approval.ts's
   * approvedBy being meaningful only for its own two edges -- passing it
   * here does not mean every RFQ transition now writes this column, only
   * that the option exists when a caller supplies it.
   */
  structuredRequirements?: Record<string, unknown> | null;
}

/**
 * The only way application code may change an RFQ's status. Validates the
 * edge against RFQ_TRANSITIONS, performs the compare-and-swap update, then
 * records an audit event -- never any of these individually. Throws
 * InvalidTransitionError for a disallowed edge, StaleTransitionError if
 * `rfqId` does not currently have status `from`, TransitionPersistenceError
 * on a database error, or AuditWriteError if the status update commits but
 * the audit insert fails.
 */
export async function transitionRfq(params: TransitionRfqParams): Promise<void> {
  const {
    client,
    rfqId,
    from,
    to,
    merchantId,
    actorType,
    buyerId,
    agentSessionId,
    inputSummary,
    outputSummary,
    policyResult,
    structuredRequirements,
  } = params;

  assertValidTransition("RFQ", RFQ_TRANSITIONS, from, to);

  await applyStatusTransition({
    client,
    table: "rfqs",
    id: rfqId,
    from,
    to,
    ...(structuredRequirements !== undefined
      ? { extraPatch: { structured_requirements: structuredRequirements } }
      : {}),
  });

  await recordAuditEvent(client, {
    merchantId,
    buyerId,
    rfqId,
    agentSessionId,
    // No RFQ transition edge maps unambiguously onto one of
    // ARCHITECTURE.md section 21's example event_type names (RFQ_CREATED
    // and RFQ_PARSED both describe row-creation/parsing-pipeline moments,
    // not a status edge this module owns), so every edge uses the generic
    // fallback.
    eventType: "RFQ_STATUS_CHANGED",
    actorType,
    action: `RFQ status changed: ${from} -> ${to}`,
    inputSummary,
    outputSummary,
    policyResult,
  });
}

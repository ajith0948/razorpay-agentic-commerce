/**
 * Shared audit-event writer. Every entity module records important
 * transitions through this single function -- AGENTS.md section 8 requires
 * every agent action to be traceable (timestamp, session, actor, action,
 * input/output summary, policy decision, related quote/order/payment id),
 * and centralizing the insert here means every entity module produces rows
 * with the same shape instead of five slightly-different ad hoc inserts.
 */

import { AuditWriteError } from "./errors.ts";
import type { StatusDbClient } from "./db.ts";
import type { AuditActorType } from "./types.ts";

/**
 * camelCase mirror of the audit_events columns (supabase/migrations/
 * 20260901120003_create_core_tables.sql). merchantId is the only required
 * relation -- the column is `not null` in the schema; every other id is
 * nullable there (an RFQ-stage event has no order yet, an order-stage event
 * may have no agent session, etc.) and defaults to null here so callers only
 * pass the ids relevant to their entity.
 */
export interface AuditEventInput {
  merchantId: string;
  buyerId?: string | null;
  rfqId?: string | null;
  quoteId?: string | null;
  orderId?: string | null;
  agentSessionId?: string | null;
  /** e.g. "RFQ_CREATED", "PAYMENT_CONFIRMED" (ARCHITECTURE.md section 21). */
  eventType: string;
  actorType: AuditActorType;
  /** Short human/machine description of what happened, e.g. "RFQ status changed". */
  action: string;
  inputSummary?: string | null;
  outputSummary?: string | null;
  policyResult?: string | null;
}

/**
 * Inserts one row into audit_events. Throws AuditWriteError if the insert
 * fails -- see that class's doc comment for why this is not swallowed, and
 * why (absent a multi-statement transaction, not introduced this phase) it
 * does not roll back the status change that normally precedes this call.
 */
export async function recordAuditEvent(
  client: StatusDbClient,
  event: AuditEventInput,
): Promise<void> {
  const { error } = await client.from("audit_events").insert({
    merchant_id: event.merchantId,
    buyer_id: event.buyerId ?? null,
    rfq_id: event.rfqId ?? null,
    quote_id: event.quoteId ?? null,
    order_id: event.orderId ?? null,
    agent_session_id: event.agentSessionId ?? null,
    event_type: event.eventType,
    actor_type: event.actorType,
    action: event.action,
    input_summary: event.inputSummary ?? null,
    output_summary: event.outputSummary ?? null,
    policy_result: event.policyResult ?? null,
  });

  if (error) {
    throw new AuditWriteError(event.eventType, error.message);
  }
}

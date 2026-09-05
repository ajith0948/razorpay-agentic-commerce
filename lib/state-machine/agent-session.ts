/**
 * Agent Session state machine -- DATABASE.md section 15, status values from
 * supabase/migrations/20260901140000_add_agent_session_status_enum.sql
 * (Phase 1). RUNNING is the only non-terminal state; COMPLETED, FAILED and
 * CANCELLED are all terminal, which is what guarantees "a completed/
 * failed/cancelled agent session cannot return to RUNNING" -- none of them
 * has an outgoing edge.
 */

import { assertValidTransition, type TransitionTable } from "./transition-table.ts";
import { applyStatusTransition, type StatusDbClient } from "./db.ts";
import { recordAuditEvent } from "./audit.ts";
import type { AgentSessionStatus, AuditActorType } from "./types.ts";

export const AGENT_SESSION_TRANSITIONS: TransitionTable<AgentSessionStatus> = {
  RUNNING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export interface TransitionAgentSessionParams {
  client: StatusDbClient;
  sessionId: string;
  from: AgentSessionStatus;
  to: AgentSessionStatus;
  /** Required: audit_events.merchant_id is NOT NULL. */
  merchantId: string;
  actorType: AuditActorType;
  buyerId?: string | null;
  rfqId?: string | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
  policyResult?: string | null;
}

/**
 * The only way application code may change an Agent Session's status.
 * Every edge in AGENT_SESSION_TRANSITIONS leaves RUNNING -- the table has
 * no other origin state -- so every successful call here is, by
 * construction, a session ending, and stamps ended_at accordingly.
 */
export async function transitionAgentSession(
  params: TransitionAgentSessionParams,
): Promise<void> {
  const {
    client,
    sessionId,
    from,
    to,
    merchantId,
    actorType,
    buyerId,
    rfqId,
    inputSummary,
    outputSummary,
    policyResult,
  } = params;

  assertValidTransition("AgentSession", AGENT_SESSION_TRANSITIONS, from, to);

  await applyStatusTransition({
    client,
    table: "agent_sessions",
    id: sessionId,
    from,
    to,
    extraPatch: { ended_at: new Date().toISOString() },
  });

  await recordAuditEvent(client, {
    merchantId,
    buyerId,
    rfqId,
    agentSessionId: sessionId,
    // No agent-session transition edge appears in ARCHITECTURE.md section
    // 21's example event_type list, so every edge uses the generic
    // fallback, matching rfq.ts/quote.ts's approach for the same reason.
    eventType: "AGENT_SESSION_STATUS_CHANGED",
    actorType,
    action: `Agent session status changed: ${from} -> ${to}`,
    inputSummary,
    outputSummary,
    policyResult,
  });
}

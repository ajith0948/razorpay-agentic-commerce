/**
 * Public types for the Agent application layer -- Agent Session (this
 * file's first half) and the Tool registry's structured input/output
 * contract (second half). Mirrors every other layer's types.ts: plain data
 * shapes only, no behavior.
 */

import type { AgentSessionStatus } from "../state-machine/index.ts";

// ---------------------------------------------------------------------------
// Agent Session
// ---------------------------------------------------------------------------

/**
 * supabase/migrations/20260901120002_create_enums.sql -- agent_session_type.
 * Not re-exported from lib/state-machine: unlike every *Status union,
 * session_type is never read or written by a transitionX() function (it is
 * set once at creation and never changes), so lib/state-machine has never
 * needed it. This module is the first and only consumer.
 *
 * Phase 9 builds the SELLER_AGENT tool surface (AGENTS.md section 7 /
 * ARCHITECTURE.md section 7 / IMPLEMENTATION_PLAN.md Phase 11 all describe a
 * seller-side agent responding to buyer RFQs -- search/quote/policy/approval/
 * payment tools operated on the merchant's behalf). BUYER_AGENT remains a
 * schema-valid value createSession() accepts -- Phase 9 does not foreclose
 * it -- but no buyer-agent-specific tool exists yet, and the tool registry's
 * own audit stamping (tools.ts) always attributes calls to actorType
 * "SELLER_AGENT".
 */
export type AgentSessionType = "SELLER_AGENT" | "BUYER_AGENT";

/**
 * Only rfqId is required from the caller. merchantId/buyerId are derived by
 * reading the referenced Rfq row (session.ts), never trusted as independent
 * caller input -- the same "don't trust a value the parent record already
 * carries" principle lib/order applies to Payment (deriving amount/currency
 * from Order) and lib/approval applies to Approval (deriving merchantId/
 * rfqId/requestedAmount from Quote). This closes the gap where an
 * LLM-influenced caller could otherwise start a session claiming a merchant
 * it has no relation to.
 */
export interface CreateAgentSessionInput {
  rfqId: string;
  sessionType: AgentSessionType;
}

export interface AgentSession {
  id: string;
  merchantId: string;
  buyerId: string;
  rfqId: string;
  sessionType: AgentSessionType;
  status: AgentSessionStatus;
  startedAt: string;
  endedAt: string | null;
}

// ---------------------------------------------------------------------------
// Tool registry -- structured input/output contract
// ---------------------------------------------------------------------------

/**
 * Every tool call the Agent layer executes is attributed to a merchant and a
 * session. Both fields are trust boundaries, not tool arguments: merchantId
 * never comes from the LLM's own tool-call JSON (an LLM must never be able
 * to claim "I am merchant X" to reach another merchant's policy/data), and
 * agentSessionId ties every tool invocation to the session that produced it
 * for audit purposes (AGENTS.md section 8). The caller that owns the
 * Agent Session (a future Phase 10 orchestration loop) constructs this
 * context once and passes it to every tool call within that session -- it
 * is never parsed out of tool input.
 */
export interface ToolExecutionContext {
  merchantId: string;
  agentSessionId: string;
}

/**
 * Step 15's six required outcome categories, verbatim:
 *   "invalid tool input / permission-policy denial / approval required /
 *   invalid lifecycle state / underlying domain failure / unexpected
 *   internal failure"
 *
 * This codebase has no separate ACL/RBAC permission system distinct from
 * merchant policy -- the Policy Engine (lib/policy) *is* the permission
 * boundary here, so "permission-policy denial" maps to one category,
 * POLICY_DENIED, rather than two. NOT_FOUND-style failures (an id that
 * doesn't resolve to a row) are bucketed under DOMAIN_ERROR: they are a
 * named, expected failure of the underlying domain call, distinct from a
 * malformed request (INVALID_INPUT) and distinct from an unexpected
 * database failure (INTERNAL_ERROR).
 */
export type ToolErrorCategory =
  | "INVALID_INPUT"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "INVALID_STATE"
  | "DOMAIN_ERROR"
  | "INTERNAL_ERROR";

export interface ToolError {
  category: ToolErrorCategory;
  message: string;
}

/**
 * Every tool call returns this shape -- never a bare thrown error, and never
 * the domain layer's own error object (whose `.message` may echo a raw
 * Postgres error string; Step 15 requires those never reach the caller).
 * executeTool() (tools.ts) is the only place that constructs this.
 */
export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

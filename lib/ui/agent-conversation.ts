/**
 * Pure UI-side conversation logic for the Agent panel (Phase 11).
 *
 * Everything in this file is plain data-in/data-out logic: no `fetch`, no
 * React, and no commerce/business logic of its own. It only decides (a) what
 * request body the next POST /api/agent call should carry, given what
 * happened last turn, and (b) how to classify a thrown ApiError for display.
 * Same separation lib/ui/format.ts already establishes alongside
 * lib/ui/api-client.ts: that file is pure presentation formatting,
 * api-client.ts is pure HTTP, this file is pure UI decision logic. None of
 * the three decide anything about RFQ/Quote/Order/Payment/Approval state
 * transitions -- those stay exactly where they already lived, behind the API
 * routes.
 *
 * The one fact this file encodes that is NOT obvious from the outside, and
 * must stay correct, is session resumability -- confirmed by reading
 * lib/agent/orchestrator.ts's own end-of-run behavior during this phase's
 * mandated inspection step:
 *
 *   result.status "final"                 -> session transitions to COMPLETED
 *   result.status "waiting_for_approval"   -> session stays RUNNING (resumable)
 *   result.status "max_iterations_reached" -> session transitions to FAILED
 *   result.status "error"                  -> session transitions to FAILED
 *   result.status "invalid_session"        -> was never RUNNING to begin with
 *
 * So the *only* outcome after which a follow-up message should reuse the
 * same sessionId is "waiting_for_approval" -- every other outcome means the
 * session already ended server-side (or never started), and the only way to
 * send another message is to start a brand-new session against the same
 * rfqId (POST /api/agent with rfqId, no sessionId). This is not a limitation
 * this file invents: it is exactly how the existing, already-tested
 * orchestrator works, and it is also exactly the mechanism the Phase 11 spec
 * asks for under "APPROVAL EXPERIENCE" ("after approval, allow the
 * buyer/agent flow to continue... through the existing deterministic
 * capabilities") -- resuming a paused session by sessionId *is* that
 * continuation path, and it is the only one that exists.
 */

import { ApiError, type AgentOrchestratorResult, type RunAgentInput } from "./api-client.ts";

// ---------------------------------------------------------------------------
// Turn targeting -- which rfqId/sessionId the next /api/agent call should use.
// ---------------------------------------------------------------------------

/** What RFQ/session a follow-up agent turn should address. */
export interface AgentTurnTarget {
  rfqId: string;
  /** Null until the first successful /api/agent call for this rfqId returns a sessionId. */
  sessionId: string | null;
  /** True only when `sessionId` is known to still be RUNNING (i.e. the last result was "waiting_for_approval"). */
  resumable: boolean;
}

/** The starting target for a brand-new conversation about a given RFQ -- no session yet. */
export function initialAgentTurnTarget(rfqId: string): AgentTurnTarget {
  return { rfqId, sessionId: null, resumable: false };
}

/** Mirrors lib/agent/orchestrator.ts's own session-ending rule -- see this file's header comment. */
export function isAgentSessionResumable(result: AgentOrchestratorResult): boolean {
  return result.status === "waiting_for_approval";
}

/** Advance the target after `result` comes back from a successful (2xx) /api/agent call. */
export function advanceAgentTurnTarget(target: AgentTurnTarget, result: AgentOrchestratorResult): AgentTurnTarget {
  return { rfqId: target.rfqId, sessionId: result.sessionId, resumable: isAgentSessionResumable(result) };
}

/**
 * The request body for the next /api/agent call, given the current target.
 * Reuses sessionId only while resumable; otherwise starts a fresh session
 * against the same rfqId (matching route.ts's own precedence rule: when both
 * are present it honors sessionId and ignores rfqId, so this never sends
 * both at once).
 */
export function buildRunAgentInput(target: AgentTurnTarget, message: string): RunAgentInput {
  return target.sessionId && target.resumable ? { message, sessionId: target.sessionId } : { message, rfqId: target.rfqId };
}

// ---------------------------------------------------------------------------
// Error classification -- the HTTP-transport-level part of the UX taxonomy
// the Phase 11 spec requires ("validation error, ... session conflict, ...").
// The other required distinctions (agent/model error, tool failure, approval
// required, maximum iteration reached) all come from a *successful* (HTTP
// 200) call's AgentOrchestratorResult.status instead, which the component
// switches on directly -- this classifier covers only what apiFetch() turns
// into a thrown ApiError: a network failure, or one of the four error codes
// app/api/agent/route.ts itself documents (400/404/409/500).
// ---------------------------------------------------------------------------

export type AgentApiErrorKind = "validation" | "not_found" | "session_conflict" | "network" | "server";

export interface AgentApiErrorDisplay {
  kind: AgentApiErrorKind;
  code: string;
  message: string;
}

/** Classifies anything runAgent() can throw. Never throws itself -- an unrecognized value safely becomes a generic "server" display. */
export function classifyAgentApiError(error: unknown): AgentApiErrorDisplay {
  if (error instanceof ApiError) {
    const kind: AgentApiErrorKind =
      error.status === 0
        ? "network"
        : error.status === 400
          ? "validation"
          : error.status === 404
            ? "not_found"
            : error.status === 409
              ? "session_conflict"
              : "server";
    return { kind, code: error.code, message: error.message };
  }
  return { kind: "server", code: "UNKNOWN_ERROR", message: "Something went wrong. Please try again." };
}

// ---------------------------------------------------------------------------
// Approval-context extraction.
//
// The only structured field on a "waiting_for_approval" result besides the
// human-readable message is `input`, typed `unknown` (it is whatever the
// model itself passed that tool call). In this codebase's current Tool
// Registry, create_payment is the only tool with approval logic (see
// lib/agent/tools.ts's handleCreatePayment), and its input is always
// `{ orderId: string }` -- so reading it structurally, rather than parsing
// the prose message, lets the UI show the order id directly without
// inventing or guessing it. If a future tool ever triggers this boundary
// with a differently-shaped input, this returns null rather than a wrong
// guess.
// ---------------------------------------------------------------------------

export function extractOrderIdFromToolInput(input: unknown): string | null {
  if (
    typeof input === "object" &&
    input !== null &&
    "orderId" in input &&
    typeof (input as { orderId: unknown }).orderId === "string"
  ) {
    return (input as { orderId: string }).orderId;
  }
  return null;
}

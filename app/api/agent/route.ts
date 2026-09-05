/**
 * POST /api/agent -- Minimal execution entry point for the Agent
 * Orchestrator (this phase's task, Step 14: "the smallest backend entry
 * point to trigger an Agent session").
 *
 * ADAPTER ONLY:
 *
 *   HTTP request -> (session lookup/creation via AgentSessionApplication)
 *                 -> Agent Orchestrator (lib/agent/orchestrator.ts)
 *                 -> ... (LLM provider, Tool Registry, application/domain,
 *                    runtime, state machine, database -- all inside the
 *                    orchestrator's own dependency chain, none of it here)
 *
 * This route contains no commerce logic of its own: it never calls the Tool
 * Registry, never evaluates policy, never decides approval, and never
 * touches Supabase directly. It has exactly two responsibilities:
 *
 *  1. Resolve which AgentSession this message belongs to, via
 *     AgentSessionApplication (lib/agent/session.ts) -- the same
 *     application layer every other Agent Session caller already uses, not
 *     a second copy of its logic. Reuse an existing session by sessionId,
 *     or start a new one from an rfqId.
 *  2. Hand that session and the message to AgentOrchestrator.run()
 *     (lib/agent/orchestrator.ts) and return its result. Every model call,
 *     every tool execution, every audit record, and every lifecycle
 *     transition happens inside that already-existing, already-tested loop
 *     -- nothing is duplicated here.
 *
 * Request body: { message: string, rfqId?: string, sessionId?: string }
 * -- at least one of rfqId/sessionId is required (enforced by
 * AgentRequestSchema's refine() below). Providing sessionId reuses that
 * existing session (rfqId, if also present, is ignored -- there is only one
 * session to run against, and honoring the caller's more specific
 * identifier over the RFQ it was itself originally derived from is the only
 * reading that never silently discards what the caller actually asked for).
 * Providing only rfqId starts a brand-new session for that RFQ via
 * createSession(), always with sessionType "SELLER_AGENT" -- the only
 * session type any tool or orchestrator actor-type in this codebase
 * currently drives (see orchestrator.ts's own ORCHESTRATOR_ACTOR_TYPE and
 * its doc comment); this route does not invent a way to choose otherwise.
 *
 * Response shape:
 *   200 { result: AgentOrchestratorResult }
 *   400 { error: { code: "INVALID_REQUEST_BODY"|"VALIDATION_ERROR", ... } }
 *   404 { error: { code: "RFQ_NOT_FOUND"|"SESSION_NOT_FOUND", ... } }
 *   409 { error: { code: "SESSION_NOT_RUNNING", message, sessionId, status } }
 *   503 { error: { code: "AI_SERVICE_NOT_CONFIGURED", message } } -- GEMINI_API_KEY missing/empty locally
 *   500 { error: { code: "INTERNAL_ERROR", message } }
 *
 * Every 200 response carries an AgentOrchestratorResult exactly as
 * orchestrator.ts's run() produced it, whatever its own `status` is
 * ("final" | "waiting_for_approval" | "max_iterations_reached" | "error")
 * -- deliberately not remapped onto different HTTP status codes for those
 * four cases. run() already never throws and already classifies every
 * outcome (including its own internal failures) into that one structured,
 * documented type; the HTTP request itself was handled successfully in
 * every one of those cases, so a client distinguishes them by reading
 * `result.status`, same as an in-process caller would. This route decides
 * only one thing the orchestrator does not: 409 SESSION_NOT_RUNNING is
 * checked here, before ever calling the orchestrator, purely so a caller
 * retrying against an already-terminal session gets a distinct HTTP status
 * it can branch on without parsing the body (the orchestrator would itself
 * report the identical situation as a 200 { result: { status:
 * "invalid_session", ... } } if this route did not intercept it first).
 */

import { z } from "zod";
import {
  createSupabaseAgentOrchestrator,
  createSupabaseAgentSessionApplication,
} from "../../../lib/agent/index.ts";
import type { AgentOrchestrator, AgentSession, AgentSessionApplication } from "../../../lib/agent/index.ts";
import { errorResponse, mapAgentErrorToResponse } from "./error-mapping.ts";

/**
 * HTTP-shape validation only -- type and presence, not commerce content.
 * message must be non-empty; at least one of rfqId/sessionId must be
 * present (the refine() below), matching the routing rule described in the
 * doc comment above.
 */
const AgentRequestSchema = z
  .object({
    message: z.string().min(1),
    rfqId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .refine((data) => Boolean(data.rfqId) || Boolean(data.sessionId), {
    message: "Either rfqId or sessionId is required.",
  });

export interface AgentRouteDeps {
  sessionApp: AgentSessionApplication;
  orchestrator: AgentOrchestrator;
}

/**
 * The route's real logic, factored out from POST() so it can be unit tested
 * against fake AgentSessionApplication/AgentOrchestrator implementations
 * with no live Supabase or Gemini connection (see route.test.ts). POST()
 * below is a thin per-request wrapper -- it constructs both Supabase-backed
 * factories fresh on every call rather than once at module scope, matching
 * every other route in this project.
 */
export async function handleAgentRequest(deps: AgentRouteDeps, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body must be valid JSON.");
  }

  const parsedBody = AgentRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return errorResponse(400, "INVALID_REQUEST_BODY", "Request body failed validation.", {
      details: parsedBody.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const { message, rfqId, sessionId } = parsedBody.data;

  try {
    let session: AgentSession;
    if (sessionId) {
      session = await deps.sessionApp.getSession(sessionId);
    } else if (rfqId) {
      session = await deps.sessionApp.createSession({ rfqId, sessionType: "SELLER_AGENT" });
    } else {
      // Unreachable: AgentRequestSchema's refine() above already guarantees
      // at least one of rfqId/sessionId is present.
      return errorResponse(400, "INVALID_REQUEST_BODY", "Either rfqId or sessionId is required.");
    }

    if (session.status !== "RUNNING") {
      return errorResponse(
        409,
        "SESSION_NOT_RUNNING",
        `Agent session ${session.id} is not RUNNING (status: ${session.status}).`,
        { sessionId: session.id, status: session.status },
      );
    }

    const result = await deps.orchestrator.run({ session, message });
    return Response.json({ result }, { status: 200 });
  } catch (err) {
    return mapAgentErrorToResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  // Constructing these two factories can itself throw synchronously --
  // most notably createSupabaseAgentOrchestrator() -> createGeminiModelProvider()
  // when GEMINI_API_KEY is unset/empty (GeminiProviderError; a local
  // environment problem, not a bug -- see error-mapping.ts). That throw
  // happens before handleAgentRequest's own try/catch is ever entered (it
  // is an argument expression, evaluated first), so without this try/catch
  // here it would propagate out of POST() as an unhandled exception --
  // Next.js then returns a bare, empty-body 500 with none of this route's
  // usual safety guarantees (no JSON envelope, no operator log). Routing it
  // through the same mapAgentErrorToResponse() every other failure in this
  // route uses keeps that one guarantee true for every failure path, not
  // just the ones inside handleAgentRequest's own try block.
  let deps: AgentRouteDeps;
  try {
    deps = {
      sessionApp: createSupabaseAgentSessionApplication(),
      orchestrator: createSupabaseAgentOrchestrator(),
    };
  } catch (err) {
    return mapAgentErrorToResponse(err);
  }
  return handleAgentRequest(deps, request);
}

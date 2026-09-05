/**
 * Shared HTTP error-response helpers for POST /api/agent (route.ts). Not a
 * route itself -- no HTTP method exports -- so Next.js's App Router does not
 * treat this file as a Route Handler. Mirrors app/api/approvals/error-mapping.ts
 * and app/api/payments/error-mapping.ts exactly.
 *
 * This file maps only AgentSessionApplication's own errors -- session lookup
 * (getSession) and session creation (createSession), the only application-
 * layer calls route.ts makes directly. createAgentOrchestrator()'s run()
 * never throws (orchestrator.ts's own documented contract: every failure
 * path, including its own internal errors, is caught inside the loop and
 * turned into a structured AgentOrchestratorResult); every agent-level
 * outcome comes back as a normal 200 with that result in the body (see
 * route.ts's doc comment), never routed through this error mapper. This
 * mapper's 500 branch exists only for AgentSessionPersistenceError and any
 * wholly unexpected throw from the two AgentSessionApplication calls
 * themselves (or, defensively, from the orchestrator, since route.ts wraps
 * both together -- see route.ts).
 *
 * Post-Phase-12 demo-UX pass: route.ts's POST() now also wraps its own
 * Supabase/Gemini factory construction (createSupabaseAgentOrchestrator(),
 * createSupabaseAgentSessionApplication()) in a try/catch that calls this
 * same mapper, so a GeminiProviderError thrown there (GEMINI_API_KEY unset
 * or empty -- the only way createGeminiModelProvider() throws; it is a pure,
 * synchronous, no-network config check, never a live-call failure -- a live
 * call's own errors are caught *inside* the orchestrator's run() per the
 * contract above and never reach here) gets the dedicated 503 branch below
 * instead of escaping as an unhandled exception (a bare, empty-body 500 with
 * none of this file's safety guarantees -- no JSON envelope, no operator
 * log). This keeps the "route.ts wraps both together" comment above
 * literally true, not just aspirational.
 */

import {
  AgentSessionNotFoundError,
  AgentSessionRfqNotFoundError,
  AgentSessionValidationError,
  GeminiProviderError,
} from "../../../lib/agent/index.ts";

/** Uniform error envelope for every non-2xx response POST /api/agent returns. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Maps an error thrown by AgentSessionApplication's getSession()/
 * createSession() (or an unexpected throw from anywhere else in
 * handleAgentRequest's try block, or from route.ts's own factory
 * construction in POST()) to a safe HTTP response.
 *
 *   400 VALIDATION_ERROR         -- AgentSessionValidationError (bad rfqId/sessionType on create)
 *   404 RFQ_NOT_FOUND            -- AgentSessionRfqNotFoundError (createSession's rfqId does not reference any Rfq)
 *   404 SESSION_NOT_FOUND        -- AgentSessionNotFoundError (sessionId does not reference any Agent Session)
 *   503 AI_SERVICE_NOT_CONFIGURED -- GeminiProviderError (GEMINI_API_KEY missing/empty -- a local environment
 *                                    problem, not a bug; message is deliberately buyer-facing, not the provider's
 *                                    own developer-oriented wording, and never echoes any credential)
 *   500 INTERNAL_ERROR           -- AgentSessionPersistenceError and anything else
 */
export function mapAgentErrorToResponse(err: unknown): Response {
  if (err instanceof AgentSessionValidationError) {
    return errorResponse(400, "VALIDATION_ERROR", err.message, { field: err.field });
  }
  if (err instanceof AgentSessionRfqNotFoundError) {
    return errorResponse(404, "RFQ_NOT_FOUND", err.message, { rfqId: err.rfqId });
  }
  if (err instanceof AgentSessionNotFoundError) {
    return errorResponse(404, "SESSION_NOT_FOUND", err.message, { sessionId: err.sessionId });
  }
  if (err instanceof GeminiProviderError) {
    // Logged for operators (never echoed: could reflect env-var setup
    // details we don't want in a client-visible message even though this
    // particular class never includes the key itself -- see gemini-provider.ts).
    console.error("Agent API: AI provider not configured", err);
    return errorResponse(
      503,
      "AI_SERVICE_NOT_CONFIGURED",
      "The AI service isn't configured yet. Add GEMINI_API_KEY to run the live agent.",
    );
  }
  // AgentSessionPersistenceError and anything wholly unexpected: a real
  // failure on our side. Logged for operators, never echoed to the client.
  console.error("Agent API: unexpected error", err);
  return errorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again.");
}

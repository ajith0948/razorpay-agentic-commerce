/**
 * The Agent Orchestrator -- the one place in this codebase that drives a
 * bounded LLM tool-calling loop. This file, and only this file, is allowed
 * to call both an AgentModelProvider and a Tool Registry together in a loop;
 * every other file either provides one of those two things or consumes this
 * orchestrator's result.
 *
 * Full dependency chain this file completes (this phase's task, restated
 * here as the standing architectural contract for this file):
 *
 *   User/API trigger -> Agent Orchestrator (this file) -> LLM Provider
 *     -> Tool call -> Agent Tool Registry -> Application/Domain -> Runtime
 *     -> State Machine -> Database -> Tool result -> LLM -> next action /
 *     final response
 *
 * The orchestrator is an *orchestrator*, never a replacement for the
 * deterministic commerce engine (AGENTS.md sections 4-6): it never touches
 * Supabase, never calls a state-machine transition function, and never
 * decides policy or approval outcomes itself. Every commerce fact it acts on
 * comes back from `toolRegistry.executeByName()` -- the same Tool Registry
 * boundary tools.ts already enforces (Zod-validated input, a closed set of
 * named tools, a ToolResult it can never fabricate). This file's own job is
 * strictly: run the bounded request/response loop, feed tool results back to
 * the model, and stop safely at a handful of well-defined boundaries
 * (approval required, max iterations, an unexpected failure).
 *
 * `createAgentOrchestrator(deps)` is the pure, dependency-injected core --
 * it has no awareness of Gemini, Zod, or Supabase; every dependency is
 * injected as an already-built interface. `createSupabaseAgentOrchestrator()`
 * below it is the convenience factory real application code (the API route)
 * calls, composing the real Gemini provider, the real Supabase-backed Tool
 * Registry, and the real Supabase-backed Agent Session application --
 * mirroring the same "pure factory + Supabase convenience factory, same
 * file" shape session.ts and tools.ts already use.
 *
 * `run()` is designed to never throw: every failure path (the provider
 * throwing, a tool execution throwing -- including an audit-write failure
 * propagating out of the Tool Registry's execute() -- or the end-of-run
 * session transition itself failing) is caught internally and turned into a
 * structured AgentOrchestratorResult instead.
 */

import { createGeminiModelProvider } from "./gemini-provider.ts";
import { createSupabaseToolRegistry } from "./tools.ts";
import type { ToolRegistry } from "./tools.ts";
import { buildAgentToolDefinitions } from "./tool-definitions.ts";
import { createSupabaseAgentSessionApplication } from "./session.ts";
import type { AgentSessionApplication, TransitionSessionInput } from "./session.ts";
import { DEFAULT_AGENT_SYSTEM_INSTRUCTIONS, buildRfqContextInstructions } from "./system-instructions.ts";
import type { AgentMessage, AgentModelProvider, AgentToolDefinition } from "./model-provider.ts";
import type { AgentSession, ToolExecutionContext } from "./types.ts";

/**
 * One iteration is one full model turn (one call to provider.generate()),
 * regardless of how many tool calls that turn requests. 8 is enough for a
 * realistic multi-step commerce conversation (look up RFQ, validate policy,
 * create quote, request approval, ...) while still guaranteeing the loop
 * cannot run unbounded (AGENTS.md section 11: "Avoid... Infinite agent
 * loops"). Configurable per orchestrator instance via
 * AgentOrchestratorDeps.maxIterations -- never hardcoded anywhere else.
 */
export const DEFAULT_MAX_ITERATIONS = 8;

export interface AgentOrchestratorDeps {
  provider: AgentModelProvider;
  /**
   * Narrowed to the one method this file actually calls -- every tool
   * execution goes through the real Tool Registry's executeByName(), which
   * is itself the tool-name/argument validation boundary (tools.ts: unknown
   * names are rejected as INVALID_INPUT before lookup, input is
   * Zod-validated via safeParse, and it never throws for a bad call). This
   * file has no business depending on the rest of ToolRegistry's surface.
   */
  toolRegistry: Pick<ToolRegistry, "executeByName">;
  /**
   * The tool catalog handed to the model every turn. Built by the caller
   * (buildAgentToolDefinitions(), tool-definitions.ts) from the same
   * ToolRegistry's real Zod schemas -- this file never derives it itself,
   * keeping the orchestration loop's own logic free of any Zod/JSON-Schema
   * concern.
   */
  toolDefinitions: readonly AgentToolDefinition[];
  /** Bound to a real AgentSessionApplication's transitionSession -- the only way this file ever changes a session's status. */
  transitionSession: AgentSessionApplication["transitionSession"];
  /** Defaults to DEFAULT_AGENT_SYSTEM_INSTRUCTIONS (system-instructions.ts). */
  systemInstructions?: string;
  /** Defaults to DEFAULT_MAX_ITERATIONS. */
  maxIterations?: number;
}

export interface AgentOrchestratorRunInput {
  session: AgentSession;
  message: string;
  /**
   * Prior conversation turns, oldest first. Always empty/omitted today --
   * there is no conversation-persistence schema yet (this phase's task
   * deliberately does not add one). Accepting it here, rather than assuming
   * every run starts from nothing, is the only accommodation made for a
   * future persistence layer; nothing about this type or this loop assumes
   * history stays in memory.
   */
  history?: readonly AgentMessage[];
}

/**
 * Every shape run() can return. There is no variant for "the LLM did
 * something directly" -- a run either produces a final answer, stops at the
 * human-approval boundary, stops because it ran out of iterations, was never
 * runnable (session not RUNNING), or failed unexpectedly. All five carry
 * `sessionId`; the three that represent a loop that actually executed also
 * carry `iterations`.
 */
export type AgentOrchestratorResult =
  | { status: "final"; sessionId: string; iterations: number; text: string }
  | {
      status: "waiting_for_approval";
      sessionId: string;
      iterations: number;
      /** The tool call whose result carried ToolErrorCategory "APPROVAL_REQUIRED" -- the call that tripped the boundary, never executed as if approved. */
      toolName: string;
      toolCallId: string;
      input: unknown;
      /** The ToolError.message explaining what is pending, safe to show a human. */
      message: string;
    }
  | { status: "max_iterations_reached"; sessionId: string; iterations: number }
  | { status: "invalid_session"; sessionId: string; reason: string }
  | { status: "error"; sessionId: string; iterations: number; message: string };

export interface AgentOrchestrator {
  run(input: AgentOrchestratorRunInput): Promise<AgentOrchestratorResult>;
}

/**
 * All agent-driven audit/session-transition actions in this codebase are
 * stamped actorType "SELLER_AGENT" regardless of AgentSession.sessionType --
 * the same convention tools.ts's own audit stamping already established
 * (see types.ts's doc comment on AgentSessionType: no BUYER_AGENT tool
 * exists yet, and AuditActorType itself has no "BUYER_AGENT" value to map
 * to). This file matches that existing convention rather than inventing a
 * new one.
 */
const ORCHESTRATOR_ACTOR_TYPE = "SELLER_AGENT" as const;

export function createAgentOrchestrator(deps: AgentOrchestratorDeps): AgentOrchestrator {
  const systemInstructions = deps.systemInstructions ?? DEFAULT_AGENT_SYSTEM_INSTRUCTIONS;
  const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  /**
   * The only place this file transitions a session's status. Wraps
   * transitionSession in try/catch and swallows (logging only) any failure
   * -- an audit/persistence problem while *ending* a run must never override
   * the orchestration result already decided, and must never make run()
   * throw.
   */
  async function endSession(params: TransitionSessionInput): Promise<void> {
    try {
      await deps.transitionSession(params);
    } catch (err) {
      console.error(
        "[lib/agent] orchestrator failed to transition session at end of run:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async function run(input: AgentOrchestratorRunInput): Promise<AgentOrchestratorResult> {
    const { session, message } = input;
    const history = input.history ?? [];

    // A session not currently RUNNING (COMPLETED/FAILED/CANCELLED, all
    // terminal -- lib/state-machine/agent-session.ts) cannot be resumed by
    // pretending it is: no model call, no tool call, no transition attempt.
    if (session.status !== "RUNNING") {
      return {
        status: "invalid_session",
        sessionId: session.id,
        reason: `session status is ${session.status}, expected RUNNING`,
      };
    }

    const ctx: ToolExecutionContext = { merchantId: session.merchantId, agentSessionId: session.id };
    // Context-retention fix: fold the session's own rfqId into this run's
    // system instructions (once, not per-iteration -- every model turn in
    // this run shares it) so the model knows which RFQ it's already working
    // with and can call get_rfq for authoritative details instead of asking
    // the buyer to repeat them. No-op (identical to the base
    // systemInstructions) when the session has no rfqId, which preserves
    // today's behavior exactly for that case.
    const rfqId = session.rfqId?.trim();
    const effectiveSystemInstructions = rfqId
      ? `${systemInstructions}\n\n${buildRfqContextInstructions(rfqId)}`
      : systemInstructions;
    const messages: AgentMessage[] = [...history, { role: "user", text: message }];
    let iterations = 0;

    try {
      while (true) {
        if (iterations >= maxIterations) {
          // Explicit bounded-loop protection: stop safely, report a
          // controlled result, never continue indefinitely, never silently
          // claim completion.
          await endSession({
            sessionId: session.id,
            from: "RUNNING",
            to: "FAILED",
            merchantId: session.merchantId,
            actorType: ORCHESTRATOR_ACTOR_TYPE,
            buyerId: session.buyerId,
            rfqId: session.rfqId,
            inputSummary: message.slice(0, 500),
            outputSummary: `Stopped after reaching the maximum of ${maxIterations} model iterations without a final response.`,
          });
          return { status: "max_iterations_reached", sessionId: session.id, iterations };
        }
        iterations += 1;

        const response = await deps.provider.generate({ systemInstructions: effectiveSystemInstructions, tools: deps.toolDefinitions, messages });

        if (response.kind === "final") {
          await endSession({
            sessionId: session.id,
            from: "RUNNING",
            to: "COMPLETED",
            merchantId: session.merchantId,
            actorType: ORCHESTRATOR_ACTOR_TYPE,
            buyerId: session.buyerId,
            rfqId: session.rfqId,
            inputSummary: message.slice(0, 500),
            outputSummary: response.text.slice(0, 500),
          });
          return { status: "final", sessionId: session.id, iterations, text: response.text };
        }

        // response.kind === "tool_calls"
        messages.push({ role: "model", text: response.text, toolCalls: response.toolCalls });

        for (const call of response.toolCalls) {
          // No separate name/argument validation happens here before this
          // call: executeByName() *is* that validation boundary (unknown
          // tool names and malformed input both come back as a normal
          // {ok:false} ToolResult, never a throw, never an execution) --
          // duplicating that check here would be a second, driftable copy
          // of the same rule. This is also what makes it safe to call
          // executeByName with literally any model-supplied name/input:
          // it can never reach an arbitrary function.
          const result = await deps.toolRegistry.executeByName(call.name, call.input, ctx);

          if (!result.ok && result.error.category === "APPROVAL_REQUIRED") {
            // Human-approval circuit breaker: stop immediately. Do not call
            // the model again, do not execute any further calls still
            // queued in this same turn, and do not transition the session
            // -- it stays RUNNING so a future resume mechanism can pick it
            // back up once a human has actually acted. Never call
            // create_payment (or anything else) as though this were
            // approved, and never let the model talk itself past this.
            return {
              status: "waiting_for_approval",
              sessionId: session.id,
              iterations,
              toolName: call.name,
              toolCallId: call.id,
              input: call.input,
              message: result.error.message,
            };
          }

          messages.push({ role: "tool_result", toolCallId: call.id, toolName: call.name, result });
        }
        // Every other {ok:false} category (INVALID_INPUT, POLICY_DENIED,
        // INVALID_STATE, DOMAIN_ERROR, INTERNAL_ERROR) is fed back to the
        // model like any other tool result above, and the loop continues --
        // only APPROVAL_REQUIRED stops the run.
      }
    } catch (err) {
      console.error("[lib/agent] orchestrator run failed:", err instanceof Error ? err.message : err);
      await endSession({
        sessionId: session.id,
        from: "RUNNING",
        to: "FAILED",
        merchantId: session.merchantId,
        actorType: ORCHESTRATOR_ACTOR_TYPE,
        buyerId: session.buyerId,
        rfqId: session.rfqId,
        inputSummary: message.slice(0, 500),
        outputSummary: "Orchestrator run failed with an internal error.",
      });
      return {
        status: "error",
        sessionId: session.id,
        iterations,
        message: "The agent run failed unexpectedly. Please try again.",
      };
    }
  }

  return { run };
}

/**
 * Convenience factory for real application code (the /api/agent route):
 * an AgentOrchestrator wired to the real Gemini provider, the real
 * Supabase-backed Tool Registry, and the real Supabase-backed Agent Session
 * application. Every override is independently optional so tests can
 * replace exactly the piece they care about with a fake; the Supabase-backed
 * Tool Registry is only constructed at all when either toolRegistry or
 * toolDefinitions is left un-overridden (both together avoid it entirely).
 * Constructed fresh per call, never at module scope -- same convention as
 * every other createSupabaseXApplication()/createSupabaseXRegistry() in
 * this codebase.
 */
export function createSupabaseAgentOrchestrator(overrides: Partial<AgentOrchestratorDeps> = {}): AgentOrchestrator {
  const provider = overrides.provider ?? createGeminiModelProvider();

  let toolRegistry = overrides.toolRegistry;
  let toolDefinitions = overrides.toolDefinitions;
  if (!toolRegistry || !toolDefinitions) {
    const registry = createSupabaseToolRegistry();
    toolRegistry ??= registry;
    toolDefinitions ??= buildAgentToolDefinitions(registry);
  }

  const transitionSession = overrides.transitionSession ?? createSupabaseAgentSessionApplication().transitionSession;

  return createAgentOrchestrator({
    provider,
    toolRegistry,
    toolDefinitions,
    transitionSession,
    systemInstructions: overrides.systemInstructions,
    maxIterations: overrides.maxIterations,
  });
}

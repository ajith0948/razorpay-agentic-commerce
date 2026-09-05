/**
 * The vendor-agnostic boundary between the Agent Orchestrator (orchestrator.ts)
 * and whatever LLM actually powers it. Every type here is provider-neutral:
 * nothing in this file, or anything that imports only this file, knows
 * Gemini (or any other vendor) exists.
 *
 * Modeled in spirit on lib/rfq/requirements-parser.ts's RequirementsParser --
 * a narrow interface plus a concrete factory, designed as "a pure
 * dependency-injection swap for a future LLM-backed implementation." The
 * same shape applies here one level up: AgentModelProvider is the swappable
 * seam, and lib/agent/gemini-provider.ts is today's one implementation of
 * it. A second provider (a different vendor, or a scripted fake for tests)
 * implements this same interface and nothing else in lib/agent changes.
 *
 * AGENTS.md section 4 draws the line this file exists to enforce in types:
 * the AI may "understand," "compare," "explain," "negotiate within limits,"
 * and "request approval" -- all of that is exactly "produce a final text
 * response or ask to call a tool," which is all an AgentModelProvider can
 * ever return. It has no way to return anything else: no method for
 * mutating state, no method for reaching Supabase, Razorpay, or any
 * transition function. Those stay reachable only through the Agent Tool
 * Registry (tools.ts), via the orchestrator (orchestrator.ts) -- never
 * through this interface.
 */

import type { ToolResult } from "./types.ts";

/**
 * One tool, described in the vendor-neutral shape every provider adapter
 * translates to its own wire format. `inputSchema` is a plain JSON Schema
 * object (see tool-definitions.ts) -- deliberately not a Zod type here, so
 * this file never needs to import Zod or know how the schema was produced.
 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * One tool call the model asked for. `id` correlates this call to the
 * AgentMessage["tool_result"] fed back for it later in the same run --
 * Gemini's own wire format has no equivalent id (gemini-provider.ts
 * synthesizes one per response), but a future provider whose vendor API
 * does supply real call ids can pass it straight through.
 */
export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
  signature?: unknown;
}

/**
 * The full conversation the orchestrator maintains for one run, in the
 * vendor-neutral shape every provider adapter translates to/from its own
 * chat format. Sections 12/2 of this phase's task: in-memory and
 * request-scoped only -- there is no dedicated conversation-persistence
 * schema, and this type does not assume one. A future phase that adds
 * persistence can serialize an AgentMessage[] as-is; nothing about this
 * shape depends on staying in memory.
 *
 *   "user"        -- what the human/API caller said.
 *   "model"        -- what the model said/requested this turn. `text` is
 *                      `null` when the model only requested tool calls with
 *                      no accompanying narration; `toolCalls` is `[]` for a
 *                      pure final-text turn.
 *   "tool_result"  -- the orchestrator's own record of what executing one
 *                      tool call actually produced (via the Tool Registry,
 *                      never anything else), fed back to the model on its
 *                      next turn. This is always a real ToolResult the
 *                      registry returned -- never invented by the
 *                      orchestrator or the provider.
 */
export type AgentMessage =
  | { role: "user"; text: string }
  | { role: "model"; text: string | null; toolCalls: readonly AgentToolCall[] }
  | { role: "tool_result"; toolCallId: string; toolName: string; result: ToolResult<unknown> };

/**
 * Everything a provider needs to produce one turn: the fixed system
 * instructions (system-instructions.ts), the full tool catalog available
 * this run (tool-definitions.ts, derived from the real Tool Registry), and
 * the conversation so far. Deliberately does not carry an AgentSession or
 * any commerce-domain type -- a provider adapter has no reason to know what
 * an RFQ or a Quote is.
 */
export interface AgentModelRequest {
  systemInstructions: string;
  tools: readonly AgentToolDefinition[];
  messages: readonly AgentMessage[];
}

/**
 * A provider's answer for one turn: either a final response to show the
 * caller, or one or more tool calls the orchestrator must execute (through
 * the Tool Registry only) before calling the provider again. There is no
 * third variant -- a provider cannot return "do X directly," only "here is
 * text" or "please run this named tool."
 */
export type AgentModelResponse =
  | { kind: "final"; text: string }
  | { kind: "tool_calls"; text: string | null; toolCalls: readonly AgentToolCall[] };

/**
 * The one method the orchestrator ever calls on a provider. Implementations
 * live in their own file (gemini-provider.ts today) and must keep every
 * vendor-specific request/response detail inside that file -- nothing
 * vendor-specific may leak into this type or into orchestrator.ts.
 */
export interface AgentModelProvider {
  generate(request: AgentModelRequest): Promise<AgentModelResponse>;
}

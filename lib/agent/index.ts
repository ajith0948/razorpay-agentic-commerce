/**
 * Public barrel for the Agent application layer -- Agent Session
 * (session.ts) and the Tool registry (tools.ts). Curated on purpose, same
 * discipline as every other layer's index.ts (lib/order/index.ts,
 * lib/approval/index.ts, ...): only the public API surface is exported
 * here. AgentSessionDbClient/toAgentSessionDbClient/AgentSessionRow/
 * NewAgentSessionRow/RfqRefRow (db.ts, supabase-agent-session-db.ts) and
 * ToolPolicyDeniedError/ToolApprovalRequiredError/classifyError/
 * TOOL_REGISTRY (tools.ts-internal) all stay un-exported so callers can
 * only reach this layer through its application-level factories.
 *
 * No separate application.ts file: unlike lib/order or lib/payment (which
 * compose several concerns behind one interface because callers need them
 * together), AgentSessionApplication and ToolRegistry are independently
 * useful and independently composable -- a future Phase 10 orchestration
 * loop is expected to hold one of each side by side, not a single merged
 * object, and there is no additional composition logic between them to
 * put in a third file. The Phase 9 spec's own file list is explicitly
 * offered as "possible, non-mandatory"; this barrel is the composition
 * point instead, exactly as that list permits.
 *
 * Extended (this phase's task) with the orchestration loop itself: the
 * vendor-neutral model-provider boundary (model-provider.ts), the Gemini
 * adapter (gemini-provider.ts), the tool-catalog builder (tool-definitions.ts),
 * the default system instructions (system-instructions.ts), and the
 * orchestrator (orchestrator.ts) that composes all of the above with
 * AgentSessionApplication and ToolRegistry into one bounded run() loop.
 * ORCHESTRATOR_ACTOR_TYPE and every other orchestrator.ts-internal helper
 * stay un-exported, matching this file's existing curation discipline.
 */

// Agent Session
export type { AgentSession, AgentSessionType, CreateAgentSessionInput } from "./types.ts";
export {
  AgentSessionNotFoundError,
  AgentSessionPersistenceError,
  AgentSessionRfqNotFoundError,
  AgentSessionValidationError,
} from "./errors.ts";
export type {
  AgentSessionApplication,
  AgentSessionApplicationDeps,
  TransitionSessionInput,
} from "./session.ts";
export { createAgentSessionApplication, createSupabaseAgentSessionApplication } from "./session.ts";

// Tool registry -- structured input/output contract
export type { ToolError, ToolErrorCategory, ToolExecutionContext, ToolResult } from "./types.ts";
export type {
  ToolDefinition,
  ToolDeps,
  ToolName,
  ToolRegistry,
  ToolRegistryDeps,
} from "./tools.ts";
export { TOOL_NAMES, createSupabaseToolRegistry, createToolRegistry, isToolName } from "./tools.ts";

// Model provider -- the vendor-neutral LLM boundary
export type {
  AgentMessage,
  AgentModelProvider,
  AgentModelRequest,
  AgentModelResponse,
  AgentToolCall,
  AgentToolDefinition,
} from "./model-provider.ts";

// Tool catalog exposed to the LLM, built from the real Tool Registry's own schemas
export { buildAgentToolDefinitions } from "./tool-definitions.ts";

// Gemini adapter -- the one AgentModelProvider implementation today
export type { GeminiProviderConfig } from "./gemini-provider.ts";
export { GeminiProviderError, createGeminiModelProvider } from "./gemini-provider.ts";

// Default system instructions given to the model on every run
export { DEFAULT_AGENT_SYSTEM_INSTRUCTIONS } from "./system-instructions.ts";

// Orchestrator -- the bounded LLM tool-calling loop
export type {
  AgentOrchestrator,
  AgentOrchestratorDeps,
  AgentOrchestratorResult,
  AgentOrchestratorRunInput,
} from "./orchestrator.ts";
export { DEFAULT_MAX_ITERATIONS, createAgentOrchestrator, createSupabaseAgentOrchestrator } from "./orchestrator.ts";

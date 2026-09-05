/**
 * Gemini implementation of AgentModelProvider (model-provider.ts).
 *
 * Per an explicit project decision (this phase's task), this adapter calls
 * Gemini's REST `generateContent` endpoint directly via the built-in
 * `fetch()` -- no `@google/genai` or any other SDK. Zero new dependencies
 * were added to package.json for this file. Every Gemini-specific
 * request/response shape lives in this one file; nothing outside it (not
 * model-provider.ts, not orchestrator.ts, not any other lib/agent file)
 * knows Gemini's wire format exists.
 *
 * Credential handling mirrors lib/supabase/server.ts's createServiceRoleClient()
 * exactly: a factory function that reads process.env.GEMINI_API_KEY itself
 * (never at module scope, so importing this file cannot throw), and throws
 * a clear error only when the factory is actually called with no key
 * available. The key is never hardcoded, never logged, and is sent only as
 * Gemini's own documented `?key=` query parameter -- never in a request
 * body or a client-reachable path.
 *
 * *** Honesty note on wire-format fidelity ***
 * This environment has no network access and no live Gemini API key, so
 * the exact request/response shape below (built from Gemini's documented
 * function-calling contract: `systemInstruction`, `contents[].parts[]`
 * with `text`/`functionCall`/`functionResponse`, `tools[].functionDeclarations[]`
 * with UPPERCASE JSON-Schema-ish `type` values) has not been exercised
 * against a real endpoint. It is deliberately isolated to a small number of
 * narrow, named conversion functions (toGeminiContent, toFunctionDeclaration,
 * toGeminiSchema, toAgentModelResponse) so that if Google's actual accepted
 * shape differs in some detail, fixing it means editing one function here,
 * not touching the provider interface, the orchestrator, or any tool code.
 * A real smoke test against a live key is recommended before relying on
 * this in a live demo; see this phase's completion report.
 */

import { z } from "zod";
import type {
  AgentMessage,
  AgentModelProvider,
  AgentModelRequest,
  AgentModelResponse,
  AgentToolCall,
  AgentToolDefinition,
} from "./model-provider.ts";

const API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** A real, currently-existing Gemini model. Override via config.model or GEMINI_MODEL without a code change. */
const DEFAULT_MODEL = "gemini-2.5-flash";

export class GeminiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiProviderError";
  }
}

export interface GeminiProviderConfig {
  /** Defaults to process.env.GEMINI_API_KEY. */
  apiKey?: string;
  /** Defaults to process.env.GEMINI_MODEL, then DEFAULT_MODEL. */
  model?: string;
  /** Injectable for tests -- defaults to the global fetch. Never mocked in production code. */
  fetchImpl?: typeof fetch;
  /** Optional passthrough to Gemini's generationConfig. Not set unless the caller provides one. */
  generationConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Request shape (this file's private wire format -- see top comment)
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: unknown;
  thought_signature?: unknown;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

interface GeminiGenerateContentRequestBody {
  systemInstruction: { parts: [{ text: string }] };
  contents: GeminiContent[];
  tools?: [{ functionDeclarations: GeminiFunctionDeclaration[] }];
  generationConfig?: Record<string, unknown>;
}

/** One AgentMessage -> one GeminiContent. Tool results come back as a "user" turn -- Gemini's contents.role enum has no third value for them. */
function toGeminiContent(message: AgentMessage): GeminiContent {
  if (message.role === "user") {
    return { role: "user", parts: [{ text: message.text }] };
  }
  if (message.role === "model") {
    const parts: GeminiPart[] = [];
    if (message.text) {
      parts.push({ text: message.text });
    }
    for (const call of message.toolCalls) {
      const part: GeminiPart = { functionCall: { name: call.name, args: (call.input as Record<string, unknown>) ?? {} } };
      if (call.signature !== undefined) {
        // API error specifies thought_signature, but response is thoughtSignature
        part.thought_signature = call.signature;
        part.thoughtSignature = call.signature;
      }
      parts.push(part);
    }
    return { role: "model", parts };
  }
  // "tool_result": the whole ToolResult<unknown> (ok/data or ok/error) is
  // itself always a plain object, so it is passed through as Gemini's
  // required Struct payload as-is -- never unwrapped or reinterpreted here.
  // This is the orchestrator's real, already-executed tool outcome; this
  // function only reshapes it for the wire, it never invents or edits it.
  return {
    role: "user",
    parts: [{ functionResponse: { name: message.toolName, response: message.result as unknown as Record<string, unknown> } }],
  };
}

const JSON_SCHEMA_TYPE_TO_GEMINI: Record<string, string> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  object: "OBJECT",
  array: "ARRAY",
  null: "NULL",
};

/**
 * Best-effort conversion from the JSON Schema tool-definitions.ts produces
 * (via Zod's own z.toJSONSchema) to Gemini's narrower, OpenAPI-3.0-flavored
 * Schema dialect: UPPERCASE `type`, no `$schema`/`additionalProperties`
 * keys, `nullable: true` instead of a `type` array. Structural keywords
 * (properties/required/items/enum/description) are the ones the 9 real
 * tool schemas actually use and are preserved recursively; anything else
 * (numeric bounds, string-length bounds, etc.) is intentionally dropped
 * rather than guessed at -- Gemini simply won't enforce that constraint,
 * which is a strictly safer failure mode than sending a key it rejects the
 * whole request over.
 */
function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  let typeValue = schema.type;
  let nullable = false;
  if (Array.isArray(typeValue)) {
    nullable = typeValue.includes("null");
    typeValue = typeValue.find((t) => t !== "null");
  }
  if (typeof typeValue === "string" && JSON_SCHEMA_TYPE_TO_GEMINI[typeValue]) {
    out.type = JSON_SCHEMA_TYPE_TO_GEMINI[typeValue];
  }
  if (nullable) {
    out.nullable = true;
  }
  if (typeof schema.description === "string") {
    out.description = schema.description;
  }
  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum;
  }
  if (schema.properties && typeof schema.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
      props[key] = toGeminiSchema(value as Record<string, unknown>);
    }
    out.properties = props;
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    out.required = schema.required;
  }
  if (schema.items && typeof schema.items === "object") {
    out.items = toGeminiSchema(schema.items as Record<string, unknown>);
  }
  return out;
}

function toFunctionDeclaration(def: AgentToolDefinition): GeminiFunctionDeclaration {
  return { name: def.name, description: def.description, parameters: toGeminiSchema(def.inputSchema) };
}

// ---------------------------------------------------------------------------
// Response shape -- validated defensively (never trust raw `any` across an
// external HTTP boundary), matching this codebase's existing convention of
// Zod-validating everything crossing a trust boundary.
// ---------------------------------------------------------------------------

const GeminiResponsePartSchema = z.object({
  text: z.string().optional(),
  functionCall: z.object({ 
    name: z.string(), 
    args: z.record(z.string(), z.unknown()).optional(),
  }).passthrough().optional(),
  thoughtSignature: z.unknown().optional(),
  thought_signature: z.unknown().optional(),
}).passthrough();

const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(GeminiResponsePartSchema).optional() }).optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

type GeminiResponse = z.infer<typeof GeminiResponseSchema>;

function toAgentModelResponse(parsed: GeminiResponse): AgentModelResponse {
  const candidate = parsed.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  if (parts.length === 0) {
    const blockReason = parsed.promptFeedback?.blockReason;
    throw new GeminiProviderError(
      blockReason
        ? `Gemini returned no usable response (blocked: ${blockReason}).`
        : "Gemini returned no usable response (empty candidates).",
    );
  }

  const toolCalls: AgentToolCall[] = [];
  const textFragments: string[] = [];
  let callIndex = 0;
  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({ 
        id: `call_${callIndex++}`, 
        name: part.functionCall.name, 
        input: part.functionCall.args ?? {},
        signature: part.thoughtSignature ?? part.thought_signature
      });
    } else if (part.text) {
      textFragments.push(part.text);
    }
  }

  const text = textFragments.length > 0 ? textFragments.join("") : null;

  if (toolCalls.length > 0) {
    return { kind: "tool_calls", text, toolCalls };
  }
  if (text !== null) {
    return { kind: "final", text };
  }
  throw new GeminiProviderError("Gemini returned an empty response with no text and no function call.");
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * Constructs a Gemini-backed AgentModelProvider. Reads GEMINI_API_KEY (and
 * optionally GEMINI_MODEL) from process.env at call time -- never at module
 * scope, so importing this file never throws, only calling this function
 * with no key available does.
 */
export function createGeminiModelProvider(config: GeminiProviderConfig = {}): AgentModelProvider {
  const apiKeyOrUndefined = config.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKeyOrUndefined) {
    throw new GeminiProviderError(
      "GEMINI_API_KEY is not set. Add it to your environment (see .env.example) before using the Gemini model provider.",
    );
  }
  // Re-bound with an explicit `string` type (not just a flow-narrowed one):
  // control-flow narrowing of an outer `const` from a guard above does not
  // reliably persist into the nested `generate` closure below, so `apiKey`'s
  // *declared* type must itself already exclude `undefined`.
  const apiKey: string = apiKeyOrUndefined;
  const model = config.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const fetchFn = config.fetchImpl ?? fetch;

  async function generate(request: AgentModelRequest): Promise<AgentModelResponse> {
    const body: GeminiGenerateContentRequestBody = {
      systemInstruction: { parts: [{ text: request.systemInstructions }] },
      contents: request.messages.map(toGeminiContent),
      ...(request.tools.length > 0
        ? { tools: [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }] as const }
        : {}),
      ...(config.generationConfig ? { generationConfig: config.generationConfig } : {}),
    };

    // The API key is only ever placed in this URL's query string, per
    // Gemini's own documented auth mechanism -- it must never appear in a
    // thrown error message or a console.error call below.
    const url = `${API_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("[lib/agent] Gemini request failed:", err instanceof Error ? err.message : err);
      throw new GeminiProviderError("Failed to reach the Gemini API.");
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      console.error(`[lib/agent] Gemini API returned HTTP ${response.status}:`, detail);
      throw new GeminiProviderError(`Gemini API request failed with status ${response.status}.`);
    }

    let json: unknown;
    try {
      json = await response.json();
      console.log("[lib/agent] Gemini raw json:", JSON.stringify(json, null, 2));
    } catch {
      throw new GeminiProviderError("Gemini API returned a response that was not valid JSON.");
    }

    const parsed = GeminiResponseSchema.safeParse(json);
    if (!parsed.success) {
      console.error("[lib/agent] Gemini API response failed shape validation:", parsed.error.message);
      throw new GeminiProviderError("Gemini API returned a response in an unexpected shape.");
    }

    return toAgentModelResponse(parsed.data);
  }

  return { generate };
}

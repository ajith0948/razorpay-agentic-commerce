import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAgentOrchestrator, DEFAULT_MAX_ITERATIONS } from "./orchestrator.ts";
import { DEFAULT_AGENT_SYSTEM_INSTRUCTIONS, buildRfqContextInstructions } from "./system-instructions.ts";
import type { AgentModelProvider, AgentModelRequest, AgentModelResponse, AgentToolDefinition } from "./model-provider.ts";
import type { ToolRegistry } from "./tools.ts";
import type { AgentSession, ToolExecutionContext, ToolResult } from "./types.ts";
import type { AgentSessionApplication, TransitionSessionInput } from "./session.ts";

/**
 * lib/agent/orchestrator.test.ts -- exercises createAgentOrchestrator()
 * (the pure, dependency-injected core) entirely against fakes: a scripted
 * AgentModelProvider, a recording tool registry, and a recording
 * transitionSession. No test here touches Gemini, Supabase, or
 * createSupabaseAgentOrchestrator() -- that convenience factory is only
 * checked structurally, via a static source scan, in the "boundary
 * integrity" block at the bottom, so this suite never depends on real
 * network access or environment credentials.
 */

const BASE_SESSION: AgentSession = {
  id: "session-1",
  merchantId: "merchant-1",
  buyerId: "buyer-1",
  rfqId: "rfq-1",
  sessionType: "SELLER_AGENT",
  status: "RUNNING",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
};

const TOOL_DEFS: AgentToolDefinition[] = [
  { name: "get_rfq", description: "Fetch an RFQ.", inputSchema: { type: "object", properties: {}, required: [] } },
];

function makeScriptedProvider(responses: AgentModelResponse[]) {
  const calls: AgentModelRequest[] = [];
  let index = 0;
  const provider: AgentModelProvider = {
    async generate(request) {
      calls.push(request);
      if (index >= responses.length) {
        throw new Error("test fake: scripted provider ran out of responses");
      }
      return responses[index++];
    },
  };
  return { provider, calls };
}

function recordingToolRegistry(handler: (name: string, input: unknown, ctx: ToolExecutionContext) => Promise<ToolResult<unknown>>) {
  const calls: { name: string; input: unknown; ctx: ToolExecutionContext }[] = [];
  const registry: Pick<ToolRegistry, "executeByName"> = {
    async executeByName(name, input, ctx) {
      calls.push({ name, input, ctx });
      return handler(name, input, ctx);
    },
  };
  return { registry, calls };
}

function recordingTransitionSession() {
  const calls: TransitionSessionInput[] = [];
  const fn: AgentSessionApplication["transitionSession"] = async (params) => {
    calls.push(params);
    return { ...BASE_SESSION, status: params.to };
  };
  return { fn, calls };
}

function makeOrchestrator(opts: {
  provider: AgentModelProvider;
  toolRegistry: Pick<ToolRegistry, "executeByName">;
  transitionSession: AgentSessionApplication["transitionSession"];
  maxIterations?: number;
}) {
  return createAgentOrchestrator({
    provider: opts.provider,
    toolRegistry: opts.toolRegistry,
    toolDefinitions: TOOL_DEFS,
    transitionSession: opts.transitionSession,
    maxIterations: opts.maxIterations,
  });
}

describe("createAgentOrchestrator: provider request construction", () => {
  it("sends the default system instructions plus this session's RFQ context, the injected tool catalog, and the incoming message as a user turn", async () => {
    const { provider, calls } = makeScriptedProvider([{ kind: "final", text: "hi" }]);
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: BASE_SESSION, message: "What is the status of my RFQ?" });

    // BASE_SESSION carries an rfqId, so the base default instructions are
    // still sent verbatim, with the RFQ-context block (see the dedicated
    // "RFQ context retention" tests below) appended after them.
    assert.ok(calls[0].systemInstructions.startsWith(DEFAULT_AGENT_SYSTEM_INSTRUCTIONS));
    assert.ok(calls[0].systemInstructions.includes(BASE_SESSION.rfqId));
    assert.deepEqual(calls[0].tools, TOOL_DEFS);
    assert.deepEqual(calls[0].messages, [{ role: "user", text: "What is the status of my RFQ?" }]);
  });

  it("uses a custom systemInstructions override when provided, with this session's RFQ context still appended", async () => {
    const { provider, calls } = makeScriptedProvider([{ kind: "final", text: "hi" }]);
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = createAgentOrchestrator({
      provider,
      toolRegistry: registry,
      toolDefinitions: TOOL_DEFS,
      transitionSession,
      systemInstructions: "Custom instructions.",
    });
    await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.ok(calls[0].systemInstructions.startsWith("Custom instructions."));
    assert.ok(calls[0].systemInstructions.includes(BASE_SESSION.rfqId));
  });
});

describe("createAgentOrchestrator: tool execution", () => {
  it("executes a requested tool through the registry and feeds its result back to the model", async () => {
    const { provider, calls: providerCalls } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "get_rfq", input: { rfqId: "rfq-1" } }] },
      { kind: "final", text: "Here is the RFQ." },
    ]);
    const { registry, calls: toolCalls } = recordingToolRegistry(async (name) => {
      assert.equal(name, "get_rfq");
      return { ok: true, data: { id: "rfq-1" } };
    });
    const { fn: transitionSession, calls: transitionCalls } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "Show me the RFQ" });

    assert.deepEqual(result, { status: "final", sessionId: "session-1", iterations: 2, text: "Here is the RFQ." });
    assert.equal(toolCalls.length, 1);
    assert.deepEqual(toolCalls[0].ctx, { merchantId: "merchant-1", agentSessionId: "session-1" });

    const secondRequestMessages = providerCalls[1].messages;
    const toolResultMsg = secondRequestMessages.find((m) => m.role === "tool_result");
    assert.deepEqual(toolResultMsg, {
      role: "tool_result",
      toolCallId: "call_0",
      toolName: "get_rfq",
      result: { ok: true, data: { id: "rfq-1" } },
    });

    assert.equal(transitionCalls.length, 1);
    assert.equal(transitionCalls[0].to, "COMPLETED");
  });

  it("feeds back a non-approval tool error and continues the loop rather than stopping", async () => {
    const { provider } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "not_a_real_tool", input: {} }] },
      { kind: "final", text: "Sorry, I can't do that." },
    ]);
    const { registry } = recordingToolRegistry(async () => ({ ok: false, error: { category: "INVALID_INPUT", message: "unknown tool" } }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "do something invalid" });

    assert.equal(result.status, "final");
  });

  it("counts iterations as one per model turn across multiple sequential tool-calling turns", async () => {
    const { provider } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "get_rfq", input: {} }] },
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_1", name: "get_rfq", input: {} }] },
      { kind: "final", text: "Done." },
    ]);
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.equal(result.status, "final");
    if (result.status === "final") assert.equal(result.iterations, 3);
  });

  it("executes multiple tool calls within a single model turn in order", async () => {
    const { provider } = makeScriptedProvider([
      {
        kind: "tool_calls",
        text: null,
        toolCalls: [
          { id: "call_0", name: "get_rfq", input: {} },
          { id: "call_1", name: "get_quote", input: {} },
        ],
      },
      { kind: "final", text: "Done." },
    ]);
    const order: string[] = [];
    const { registry } = recordingToolRegistry(async (name) => {
      order.push(name);
      return { ok: true, data: {} };
    });
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.deepEqual(order, ["get_rfq", "get_quote"]);
  });

  it("converts a thrown tool-execution exception into a safe error result and marks the session FAILED", async () => {
    const { provider } = makeScriptedProvider([{ kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "get_rfq", input: {} }] }]);
    const { registry } = recordingToolRegistry(async () => {
      throw new Error("audit write failed: connection reset");
    });
    const { fn: transitionSession, calls: transitionCalls } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.ok(!result.message.includes("audit write failed"), "internal exception detail must not leak to the caller");
    }
    assert.equal(transitionCalls.length, 1);
    assert.equal(transitionCalls[0].to, "FAILED");
  });

  it("converts a thrown provider exception into a safe error result and marks the session FAILED", async () => {
    const provider: AgentModelProvider = {
      async generate() {
        throw new Error("network exploded");
      },
    };
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession, calls: transitionCalls } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.equal(result.status, "error");
    if (result.status === "error") assert.ok(!result.message.includes("network exploded"));
    assert.equal(transitionCalls[0].to, "FAILED");
  });
});

describe("createAgentOrchestrator: loop protection", () => {
  it("stops at exactly the configured maxIterations without calling the model again", async () => {
    let callCount = 0;
    const provider: AgentModelProvider = {
      async generate() {
        callCount++;
        return { kind: "tool_calls", text: null, toolCalls: [{ id: `call_${callCount}`, name: "get_rfq", input: {} }] };
      },
    };
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession, calls: transitionCalls } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession, maxIterations: 3 });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.deepEqual(result, { status: "max_iterations_reached", sessionId: "session-1", iterations: 3 });
    assert.equal(callCount, 3);
    assert.equal(transitionCalls[0].to, "FAILED");
  });

  it("uses DEFAULT_MAX_ITERATIONS when maxIterations is not configured", async () => {
    let callCount = 0;
    const provider: AgentModelProvider = {
      async generate() {
        callCount++;
        return { kind: "tool_calls", text: null, toolCalls: [{ id: `call_${callCount}`, name: "get_rfq", input: {} }] };
      },
    };
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.deepEqual(result, { status: "max_iterations_reached", sessionId: "session-1", iterations: DEFAULT_MAX_ITERATIONS });
    assert.equal(callCount, DEFAULT_MAX_ITERATIONS);
  });
});

describe("createAgentOrchestrator: session integration", () => {
  it("passes the same merchantId/agentSessionId context to every tool call in a run", async () => {
    const { provider } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "get_rfq", input: {} }] },
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_1", name: "get_quote", input: {} }] },
      { kind: "final", text: "Done." },
    ]);
    const { registry, calls } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(call.ctx, { merchantId: "merchant-1", agentSessionId: "session-1" });
    }
  });

  it("rejects a non-RUNNING session immediately without calling the model or any tool", async () => {
    const { provider, calls: providerCalls } = makeScriptedProvider([]);
    const { registry, calls: toolCalls } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession, calls: transitionCalls } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const completedSession: AgentSession = { ...BASE_SESSION, status: "COMPLETED", endedAt: "2026-01-01T00:05:00.000Z" };
    const result = await orchestrator.run({ session: completedSession, message: "hi" });

    assert.equal(result.status, "invalid_session");
    assert.equal(providerCalls.length, 0);
    assert.equal(toolCalls.length, 0);
    assert.equal(transitionCalls.length, 0);
  });

  it("never calls the tool registry for anything the model did not request", async () => {
    const { provider } = makeScriptedProvider([{ kind: "final", text: "No tools needed." }]);
    const { registry, calls } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.equal(calls.length, 0);
  });
});

describe("createAgentOrchestrator: human approval boundary", () => {
  it("stops immediately on an APPROVAL_REQUIRED tool result, without calling the model again", async () => {
    const { provider, calls: providerCalls } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "create_payment", input: { quoteId: "quote-1" } }] },
    ]);
    const { registry } = recordingToolRegistry(async () => ({
      ok: false,
      error: { category: "APPROVAL_REQUIRED", message: "This payment requires merchant approval before it can proceed." },
    }));
    const { fn: transitionSession, calls: transitionCalls } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "Pay for the order" });

    assert.deepEqual(result, {
      status: "waiting_for_approval",
      sessionId: "session-1",
      iterations: 1,
      toolName: "create_payment",
      toolCallId: "call_0",
      input: { quoteId: "quote-1" },
      message: "This payment requires merchant approval before it can proceed.",
    });
    assert.equal(providerCalls.length, 1);
    assert.equal(transitionCalls.length, 0, "session must stay RUNNING, never transitioned, on approval-required");
  });

  it("never executes remaining tool calls in the same turn after an APPROVAL_REQUIRED result", async () => {
    const { provider } = makeScriptedProvider([
      {
        kind: "tool_calls",
        text: null,
        toolCalls: [
          { id: "call_0", name: "create_payment", input: {} },
          { id: "call_1", name: "get_order", input: {} },
        ],
      },
    ]);
    const { registry, calls } = recordingToolRegistry(async (name) => {
      if (name === "create_payment") {
        return { ok: false, error: { category: "APPROVAL_REQUIRED", message: "pending approval" } };
      }
      return { ok: true, data: {} };
    });
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "create_payment");
  });

  it("hits the same approval gate again on a repeated run() against the same still-RUNNING session, never faking approval", async () => {
    const { provider } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "create_payment", input: {} }] },
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_1", name: "create_payment", input: {} }] },
    ]);
    const { registry, calls } = recordingToolRegistry(async () => ({
      ok: false,
      error: { category: "APPROVAL_REQUIRED", message: "pending approval" },
    }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const first = await orchestrator.run({ session: BASE_SESSION, message: "hi" });
    const second = await orchestrator.run({ session: BASE_SESSION, message: "hi again" });

    assert.equal(first.status, "waiting_for_approval");
    assert.equal(second.status, "waiting_for_approval");
    assert.equal(calls.length, 2);
  });
});

/**
 * Regression coverage for the context-retention bug: a buyer who already
 * established an RFQ (session.rfqId) was being asked to repeat its id,
 * delivery location, and delivery days on the very next turn, because
 * nothing about session.rfqId ever reached the model. The fix folds a small
 * RFQ-context block -- built by buildRfqContextInstructions() in
 * system-instructions.ts -- into this run's system instructions whenever
 * session.rfqId is present, and leaves systemInstructions untouched
 * otherwise.
 */
describe("createAgentOrchestrator: RFQ context retention (session.rfqId -> system instructions)", () => {
  it("1. injects the session's RFQ id and a get_rfq pointer into every provider call when the session has an rfqId", async () => {
    const { provider, calls } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "get_rfq", input: { rfqId: BASE_SESSION.rfqId } }] },
      { kind: "final", text: "Here is your RFQ." },
    ]);
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: { id: BASE_SESSION.rfqId } }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: BASE_SESSION, message: "What is the status of my RFQ?" });

    assert.equal(calls.length, 2, "context must be present on every provider call in the run, not just the first");
    for (const call of calls) {
      assert.ok(call.systemInstructions.includes(BASE_SESSION.rfqId), "must name the session's current RFQ id");
      assert.ok(call.systemInstructions.includes("get_rfq"), "must point the model at the existing get_rfq tool");
      assert.ok(call.systemInstructions.startsWith(DEFAULT_AGENT_SYSTEM_INSTRUCTIONS), "must still carry the base instructions unchanged");
    }
  });

  it("2. injects no RFQ context when the session has no rfqId (empty string), leaving systemInstructions byte-for-byte unchanged", async () => {
    const { provider, calls } = makeScriptedProvider([{ kind: "final", text: "hi" }]);
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const sessionWithoutRfq = { ...BASE_SESSION, rfqId: "" };
    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: sessionWithoutRfq, message: "hi" });

    assert.equal(calls[0].systemInstructions, DEFAULT_AGENT_SYSTEM_INSTRUCTIONS, "no RFQ block, no fake RFQ id, nothing appended");
  });

  it("treats a whitespace-only rfqId the same as no rfqId (no fake context injected)", async () => {
    const { provider, calls } = makeScriptedProvider([{ kind: "final", text: "hi" }]);
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const sessionWithBlankRfq = { ...BASE_SESSION, rfqId: "   " };
    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: sessionWithBlankRfq, message: "hi" });

    assert.equal(calls[0].systemInstructions, DEFAULT_AGENT_SYSTEM_INSTRUCTIONS);
  });

  it("3. still executes tool calls through the registry and feeds real results back to the model when RFQ context is injected", async () => {
    const { provider } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "get_rfq", input: { rfqId: BASE_SESSION.rfqId } }] },
      { kind: "final", text: "Creating your quote now." },
    ]);
    const { registry, calls: toolCalls } = recordingToolRegistry(async (name) => {
      assert.equal(name, "get_rfq");
      return { ok: true, data: { id: BASE_SESSION.rfqId, deliveryCity: "Chennai", deliveryDays: 7 } };
    });
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "Use the RFQ you just created." });

    assert.equal(result.status, "final");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, "get_rfq");
    assert.deepEqual(toolCalls[0].ctx, { merchantId: BASE_SESSION.merchantId, agentSessionId: BASE_SESSION.id });
  });

  it("4 & 5. still stops at the human-approval boundary (payment safety) unchanged when RFQ context is injected", async () => {
    const { provider, calls: providerCalls } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "create_payment", input: { quoteId: "quote-1" } }] },
    ]);
    const { registry } = recordingToolRegistry(async () => ({
      ok: false,
      error: { category: "APPROVAL_REQUIRED", message: "This payment requires merchant approval before it can proceed." },
    }));
    const { fn: transitionSession, calls: transitionCalls } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    const result = await orchestrator.run({ session: BASE_SESSION, message: "Pay for the order" });

    assert.equal(result.status, "waiting_for_approval");
    assert.equal(providerCalls.length, 1);
    assert.ok(providerCalls[0].systemInstructions.includes(BASE_SESSION.rfqId), "approval path must still carry RFQ context");
    assert.equal(transitionCalls.length, 0, "session must stay RUNNING, never transitioned, on approval-required, even with RFQ context injected");
  });

  it("6 & 7. the RFQ context block never mentions a database/table, and never contains an eval/Function code-execution primitive", () => {
    const text = buildRfqContextInstructions(BASE_SESSION.rfqId);
    for (const forbidden of [".from(", ".update(", "supabase", "eval(", "new Function(", "DROP TABLE", "DELETE FROM", "SELECT * FROM"]) {
      assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `RFQ context block must never contain "${forbidden}"`);
    }
  });

  it("8. never embeds RFQ business data or secret-shaped values -- only the id and a pointer to the existing get_rfq tool", () => {
    const text = buildRfqContextInstructions(BASE_SESSION.rfqId);
    assert.ok(text.includes(BASE_SESSION.rfqId));
    assert.ok(text.includes("get_rfq"));
    for (const forbidden of ["Chennai", "50000", "GEMINI_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "process.env", "AQ."]) {
      assert.ok(!text.includes(forbidden), `RFQ context block must never mention "${forbidden}"`);
    }
  });

  it("8. no secret-shaped value appears in any provider call's systemInstructions across a full multi-turn run", async () => {
    const { provider, calls } = makeScriptedProvider([
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_0", name: "get_rfq", input: {} }] },
      { kind: "tool_calls", text: null, toolCalls: [{ id: "call_1", name: "create_quote", input: {} }] },
      { kind: "final", text: "Done." },
    ]);
    const { registry } = recordingToolRegistry(async () => ({ ok: true, data: {} }));
    const { fn: transitionSession } = recordingTransitionSession();

    const orchestrator = makeOrchestrator({ provider, toolRegistry: registry, transitionSession });
    await orchestrator.run({ session: BASE_SESSION, message: "hi" });

    assert.ok(calls.length > 0);
    for (const call of calls) {
      for (const forbidden of ["GEMINI_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "AQ.", "process.env"]) {
        assert.ok(!call.systemInstructions.includes(forbidden), `systemInstructions sent to the model must never contain "${forbidden}"`);
      }
    }
  });
});

describe("boundary integrity: static properties of system-instructions.ts's own source", () => {
  const source = readFileSync(new URL("./system-instructions.ts", import.meta.url), "utf8");
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("never reads environment variables or secrets -- it only builds plain strings from its rfqId parameter", () => {
    assert.ok(!codeOnly.includes("process.env"), "system-instructions.ts must never read environment variables");
  });

  it("never evaluates model output as code", () => {
    assert.ok(!codeOnly.includes("eval("), "system-instructions.ts must never call eval()");
    assert.ok(!codeOnly.includes("new Function("), "system-instructions.ts must never construct a Function from a string");
  });

  it("contains no raw Supabase table access", () => {
    assert.ok(!codeOnly.includes(".from("), "no raw table access");
    assert.ok(!codeOnly.includes(".update("), "no raw row update");
  });
});

describe("boundary integrity: static properties of orchestrator.ts's own source", () => {
  const source = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

  it("never evaluates model output as code", () => {
    assert.ok(!codeOnly.includes("eval("), "orchestrator.ts must never call eval()");
    assert.ok(!codeOnly.includes("new Function("), "orchestrator.ts must never construct a Function from a string");
  });

  it("never calls the Payment/Approval capabilities that would let the agent bypass approval or declare a payment PAID", () => {
    assert.ok(!codeOnly.includes("markPaymentPaid"));
    assert.ok(!codeOnly.includes("transitionPaymentStatus"));
    assert.ok(!codeOnly.includes("transitionApprovalStatus"));
  });

  it("contains no raw Supabase table access or Razorpay reference", () => {
    assert.ok(!codeOnly.includes(".from("), "no raw table access");
    assert.ok(!codeOnly.includes(".update("), "no raw row update");
    assert.ok(!/razorpay/i.test(codeOnly), "must not reference Razorpay");
  });

  it("composes the expected real dependencies in createSupabaseAgentOrchestrator", () => {
    for (const identifier of [
      "createGeminiModelProvider",
      "createSupabaseToolRegistry",
      "buildAgentToolDefinitions",
      "createSupabaseAgentSessionApplication",
    ]) {
      assert.ok(codeOnly.includes(identifier), `expected orchestrator.ts to compose ${identifier}`);
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createGeminiModelProvider, GeminiProviderError } from "./gemini-provider.ts";
import type { AgentMessage, AgentToolDefinition } from "./model-provider.ts";

/**
 * lib/agent/gemini-provider.test.ts -- exercises the Gemini adapter entirely
 * through an injected fetchImpl fake. No test in this file makes a real
 * network call or requires a real GEMINI_API_KEY (this phase's task: `npm
 * test` must never depend on live Gemini/network access). Every
 * Gemini-specific request/response shape asserted here is this file's own
 * private wire-format contract with gemini-provider.ts -- see that file's
 * top comment for the "not live-verified against a real endpoint" caveat.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeCapturingFetch(response: Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function withEnvVar(name: string, value: string | undefined, run: () => void | Promise<void>) {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  const restore = () => {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  };
  const result = run();
  if (result instanceof Promise) {
    return result.finally(restore);
  }
  restore();
  return undefined;
}

const FINAL_TEXT_BODY = { candidates: [{ content: { parts: [{ text: "ok" }] } }] };

describe("createGeminiModelProvider: construction / credential handling", () => {
  it("throws GeminiProviderError when constructed with no API key available", async () => {
    await withEnvVar("GEMINI_API_KEY", undefined, () => {
      assert.throws(() => createGeminiModelProvider({}), GeminiProviderError);
    });
  });

  it("does not throw at construction when apiKey is passed explicitly, even with no env var", async () => {
    await withEnvVar("GEMINI_API_KEY", undefined, () => {
      assert.doesNotThrow(() => createGeminiModelProvider({ apiKey: "test-key" }));
    });
  });

  it("does not throw at construction when GEMINI_API_KEY is set in the environment", async () => {
    await withEnvVar("GEMINI_API_KEY", "env-key", () => {
      assert.doesNotThrow(() => createGeminiModelProvider({}));
    });
  });
});

describe("createGeminiModelProvider: request construction", () => {
  it("builds systemInstruction, contents, and tools.functionDeclarations from the generic request", async () => {
    const capturing = makeCapturingFetch(jsonResponse(FINAL_TEXT_BODY));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });

    const tools: AgentToolDefinition[] = [
      {
        name: "get_rfq",
        description: "Fetch an RFQ.",
        inputSchema: { type: "object", properties: { rfqId: { type: "string" } }, required: ["rfqId"] },
      },
    ];
    const messages: AgentMessage[] = [
      { role: "user", text: "Hello" },
      { role: "model", text: "Let me check.", toolCalls: [{ id: "call_0", name: "get_rfq", input: { rfqId: "rfq-1" } }] },
      { role: "tool_result", toolCallId: "call_0", toolName: "get_rfq", result: { ok: true, data: { id: "rfq-1" } } },
    ];

    await provider.generate({ systemInstructions: "Be helpful.", tools, messages });

    assert.equal(capturing.calls.length, 1);
    const { url, init } = capturing.calls[0];
    assert.ok(url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/"));
    assert.ok(url.includes(":generateContent"));
    assert.ok(url.includes("key=test-key"));
    assert.equal(init?.method, "POST");

    const body = JSON.parse(init?.body as string);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: "Be helpful." }] });
    assert.equal(body.contents.length, 3);
    assert.deepEqual(body.contents[0], { role: "user", parts: [{ text: "Hello" }] });
    assert.deepEqual(body.contents[1], {
      role: "model",
      parts: [{ text: "Let me check." }, { functionCall: { name: "get_rfq", args: { rfqId: "rfq-1" } } }],
    });
    assert.deepEqual(body.contents[2], {
      role: "user",
      parts: [{ functionResponse: { name: "get_rfq", response: { ok: true, data: { id: "rfq-1" } } } }],
    });
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].functionDeclarations[0].name, "get_rfq");
    assert.equal(body.tools[0].functionDeclarations[0].parameters.type, "OBJECT");
    assert.deepEqual(body.tools[0].functionDeclarations[0].parameters.required, ["rfqId"]);
  });

  it("preserves thought_signature when constructing a model tool call history turn", async () => {
    const capturing = makeCapturingFetch(jsonResponse(FINAL_TEXT_BODY));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    const messages: AgentMessage[] = [
      { role: "user", text: "hi" },
      { 
        role: "model", 
        text: null, 
        toolCalls: [{ id: "call_0", name: "get_rfq", input: { rfqId: "rfq-1" }, signature: "some-signature" }] 
      },
    ];
    await provider.generate({ systemInstructions: "x", tools: [], messages });
    const body = JSON.parse(capturing.calls[0].init?.body as string);
    assert.deepEqual(body.contents[1].parts, [{ functionCall: { name: "get_rfq", args: { rfqId: "rfq-1" } }, thoughtSignature: "some-signature", thought_signature: "some-signature" }]);
  });

  it("omits the text part for a model message with null text (pure tool-call turn)", async () => {
    const capturing = makeCapturingFetch(jsonResponse(FINAL_TEXT_BODY));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    const messages: AgentMessage[] = [
      { role: "user", text: "hi" },
      { role: "model", text: null, toolCalls: [{ id: "call_0", name: "get_rfq", input: { rfqId: "rfq-1" } }] },
    ];
    await provider.generate({ systemInstructions: "x", tools: [], messages });
    const body = JSON.parse(capturing.calls[0].init?.body as string);
    assert.deepEqual(body.contents[1].parts, [{ functionCall: { name: "get_rfq", args: { rfqId: "rfq-1" } } }]);
  });

  it("omits the tools field entirely when no tool definitions are provided", async () => {
    const capturing = makeCapturingFetch(jsonResponse(FINAL_TEXT_BODY));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    await provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] });
    const body = JSON.parse(capturing.calls[0].init?.body as string);
    assert.ok(!("tools" in body));
  });

  it("uses config.model when provided, overriding GEMINI_MODEL and the default", async () => {
    await withEnvVar("GEMINI_MODEL", "gemini-env-model", async () => {
      const capturing = makeCapturingFetch(jsonResponse(FINAL_TEXT_BODY));
      const provider = createGeminiModelProvider({ apiKey: "test-key", model: "gemini-config-model", fetchImpl: capturing.fn });
      await provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] });
      assert.ok(capturing.calls[0].url.includes("/models/gemini-config-model:generateContent"));
    });
  });

  it("falls back to GEMINI_MODEL, then a hardcoded default, when config.model is not set", async () => {
    await withEnvVar("GEMINI_MODEL", undefined, async () => {
      const capturing = makeCapturingFetch(jsonResponse(FINAL_TEXT_BODY));
      const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
      await provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] });
      assert.ok(/\/models\/gemini-[^:]+:generateContent/.test(capturing.calls[0].url));
    });
  });
});

describe("createGeminiModelProvider: response parsing", () => {
  it("returns a final response when Gemini returns only text", async () => {
    const capturing = makeCapturingFetch(jsonResponse(FINAL_TEXT_BODY));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    const result = await provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] });
    assert.deepEqual(result, { kind: "final", text: "ok" });
  });

  it("returns tool_calls with a synthesized id when Gemini returns one functionCall", async () => {
    const capturing = makeCapturingFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "get_rfq", args: { rfqId: "rfq-1" } } }] } }] }),
    );
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    const result = await provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] });
    assert.equal(result.kind, "tool_calls");
    if (result.kind !== "tool_calls") throw new Error("unreachable");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "get_rfq");
    assert.deepEqual(result.toolCalls[0].input, { rfqId: "rfq-1" });
    assert.equal(typeof result.toolCalls[0].id, "string");
    assert.ok(result.toolCalls[0].id.length > 0);
  });

  it("returns tool_calls with a signature when Gemini returns a thought_signature", async () => {
    const capturing = makeCapturingFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "get_rfq", args: { rfqId: "rfq-1" } }, thoughtSignature: "sig123" }] } }] }),
    );
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    const result = await provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] });
    assert.equal(result.kind, "tool_calls");
    if (result.kind !== "tool_calls") throw new Error("unreachable");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "get_rfq");
    assert.deepEqual(result.toolCalls[0].input, { rfqId: "rfq-1" });
    assert.equal(result.toolCalls[0].signature, "sig123");
  });

  it("returns multiple tool calls with distinct ids when Gemini returns multiple functionCall parts", async () => {
    const capturing = makeCapturingFetch(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "get_rfq", args: { rfqId: "rfq-1" } } },
                { functionCall: { name: "get_quote", args: { quoteId: "quote-1" } } },
              ],
            },
          },
        ],
      }),
    );
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    const result = await provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] });
    assert.equal(result.kind, "tool_calls");
    if (result.kind !== "tool_calls") throw new Error("unreachable");
    assert.equal(result.toolCalls.length, 2);
    assert.equal(new Set(result.toolCalls.map((c) => c.id)).size, 2);
    assert.equal(result.toolCalls[0].name, "get_rfq");
    assert.equal(result.toolCalls[1].name, "get_quote");
  });

  it("defaults a functionCall's missing args to an empty object", async () => {
    const capturing = makeCapturingFetch(
      jsonResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "get_merchant_policy" } }] } }] }),
    );
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    const result = await provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] });
    assert.equal(result.kind, "tool_calls");
    if (result.kind !== "tool_calls") throw new Error("unreachable");
    assert.deepEqual(result.toolCalls[0].input, {});
  });
});

describe("createGeminiModelProvider: error handling stays safe", () => {
  it("throws a safe GeminiProviderError on a non-2xx response without leaking the API key", async () => {
    const capturing = makeCapturingFetch(new Response("Invalid API key detail from server", { status: 400 }));
    const provider = createGeminiModelProvider({ apiKey: "super-secret-key", fetchImpl: capturing.fn });
    await assert.rejects(
      () => provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof GeminiProviderError);
        assert.ok(!(err as Error).message.includes("super-secret-key"));
        assert.ok((err as Error).message.includes("400"));
        return true;
      },
    );
  });

  it("throws a safe GeminiProviderError when the response body fails shape validation", async () => {
    const capturing = makeCapturingFetch(jsonResponse({ candidates: "not-an-array" }));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    await assert.rejects(
      () => provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof GeminiProviderError);
        assert.ok((err as Error).message.toLowerCase().includes("unexpected shape"));
        return true;
      },
    );
  });

  it("throws a safe GeminiProviderError when Gemini returns no candidates", async () => {
    const capturing = makeCapturingFetch(jsonResponse({ candidates: [] }));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    await assert.rejects(
      () => provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] }),
      GeminiProviderError,
    );
  });

  it("includes the block reason in the error when Gemini blocks the prompt", async () => {
    const capturing = makeCapturingFetch(jsonResponse({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    await assert.rejects(
      () => provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof GeminiProviderError);
        assert.ok((err as Error).message.includes("SAFETY"));
        return true;
      },
    );
  });

  it("throws a safe GeminiProviderError when the response body is not valid JSON", async () => {
    const capturing = makeCapturingFetch(new Response("not json{{{", { status: 200 }));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    await assert.rejects(
      () => provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] }),
      GeminiProviderError,
    );
  });

  it("throws a safe GeminiProviderError when the network request itself fails", async () => {
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: failingFetch });
    await assert.rejects(
      () => provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] }),
      (err: unknown) => {
        assert.ok(err instanceof GeminiProviderError);
        assert.ok((err as Error).message.includes("reach the Gemini API"));
        return true;
      },
    );
  });

  it("throws a safe GeminiProviderError when a functionCall part is missing its name", async () => {
    const capturing = makeCapturingFetch(jsonResponse({ candidates: [{ content: { parts: [{ functionCall: {} }] } }] }));
    const provider = createGeminiModelProvider({ apiKey: "test-key", fetchImpl: capturing.fn });
    await assert.rejects(
      () => provider.generate({ systemInstructions: "x", tools: [], messages: [{ role: "user", text: "hi" }] }),
      GeminiProviderError,
    );
  });
});

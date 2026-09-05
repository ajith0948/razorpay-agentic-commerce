import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleAgentRequest } from "./route.ts";
import type {
  AgentOrchestrator,
  AgentOrchestratorResult,
  AgentOrchestratorRunInput,
  AgentSession,
  AgentSessionApplication,
  CreateAgentSessionInput,
} from "../../../lib/agent/index.ts";
import {
  AgentSessionNotFoundError,
  AgentSessionPersistenceError,
  AgentSessionRfqNotFoundError,
  GeminiProviderError,
} from "../../../lib/agent/index.ts";

const SESSION_ID = "session-1";
const RFQ_ID = "rfq-1";
const MERCHANT_ID = "merchant-1";
const BUYER_ID = "buyer-1";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: SESSION_ID,
    merchantId: MERCHANT_ID,
    buyerId: BUYER_ID,
    rfqId: RFQ_ID,
    sessionType: "SELLER_AGENT",
    status: "RUNNING",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

/**
 * Fake AgentSessionApplication -- this route only ever calls getSession()
 * (sessionId given) or createSession() (only rfqId given). transitionSession
 * throws unconditionally: this route must never transition a session
 * directly, only the orchestrator does that, so a test would fail loudly
 * (not silently pass) if the route ever started doing so.
 */
class FakeAgentSessionApplication implements AgentSessionApplication {
  getSessionCalls: string[] = [];
  createSessionCalls: CreateAgentSessionInput[] = [];
  getSessionImpl: (sessionId: string) => Promise<AgentSession> = async (sessionId) => makeSession({ id: sessionId });
  createSessionImpl: (input: CreateAgentSessionInput) => Promise<AgentSession> = async (input) =>
    makeSession({ rfqId: input.rfqId, sessionType: input.sessionType });

  async getSession(sessionId: string): Promise<AgentSession> {
    this.getSessionCalls.push(sessionId);
    return this.getSessionImpl(sessionId);
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    this.createSessionCalls.push(input);
    return this.createSessionImpl(input);
  }

  async transitionSession(): Promise<AgentSession> {
    throw new Error(
      "FakeAgentSessionApplication: transitionSession() should not be called by POST /api/agent -- only the orchestrator transitions a session.",
    );
  }
}

/** Fake AgentOrchestrator -- records every run() call and returns a scripted result. */
class FakeAgentOrchestrator implements AgentOrchestrator {
  runCalls: AgentOrchestratorRunInput[] = [];
  runImpl: (input: AgentOrchestratorRunInput) => Promise<AgentOrchestratorResult> = async (input) => ({
    status: "final",
    sessionId: input.session.id,
    iterations: 1,
    text: "ok",
  });

  async run(input: AgentOrchestratorRunInput): Promise<AgentOrchestratorResult> {
    this.runCalls.push(input);
    return this.runImpl(input);
  }
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(rawBody: string): Request {
  return new Request("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

describe("POST /api/agent: success via rfqId (creates a session)", () => {
  it("creates a new SELLER_AGENT session and runs the orchestrator against it", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID, message: "hi" }));

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.result.status, "final");

    assert.deepEqual(sessionApp.createSessionCalls, [{ rfqId: RFQ_ID, sessionType: "SELLER_AGENT" }]);
    assert.equal(sessionApp.getSessionCalls.length, 0);
    assert.equal(orchestrator.runCalls.length, 1);
    assert.equal(orchestrator.runCalls[0].message, "hi");
    assert.equal(orchestrator.runCalls[0].session.rfqId, RFQ_ID);
  });
});

describe("POST /api/agent: success via sessionId (reuses, never creates)", () => {
  it("reuses the existing session and never calls createSession", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    const res = await handleAgentRequest(
      { sessionApp, orchestrator },
      jsonRequest({ sessionId: SESSION_ID, message: "hi again" }),
    );

    assert.equal(res.status, 200);
    assert.deepEqual(sessionApp.getSessionCalls, [SESSION_ID]);
    assert.equal(sessionApp.createSessionCalls.length, 0);
    assert.equal(orchestrator.runCalls.length, 1);
    assert.equal(orchestrator.runCalls[0].session.id, SESSION_ID);
  });

  it("prefers sessionId over rfqId when both are given", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    await handleAgentRequest(
      { sessionApp, orchestrator },
      jsonRequest({ sessionId: SESSION_ID, rfqId: RFQ_ID, message: "hi" }),
    );

    assert.deepEqual(sessionApp.getSessionCalls, [SESSION_ID]);
    assert.equal(sessionApp.createSessionCalls.length, 0);
  });
});

describe("POST /api/agent: request validation (400)", () => {
  it("returns 400 INVALID_REQUEST_BODY for malformed JSON", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    const res = await handleAgentRequest({ sessionApp, orchestrator }, rawRequest("{not json"));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(sessionApp.getSessionCalls.length, 0);
    assert.equal(sessionApp.createSessionCalls.length, 0);
    assert.equal(orchestrator.runCalls.length, 0);
  });

  it("returns 400 INVALID_REQUEST_BODY when message is missing", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(sessionApp.createSessionCalls.length, 0);
  });

  it("returns 400 INVALID_REQUEST_BODY when neither rfqId nor sessionId is given", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ message: "hi" }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(sessionApp.getSessionCalls.length, 0);
    assert.equal(sessionApp.createSessionCalls.length, 0);
    assert.equal(orchestrator.runCalls.length, 0);
  });
});

describe("POST /api/agent: session resolution errors (404)", () => {
  it("maps AgentSessionRfqNotFoundError to 404 RFQ_NOT_FOUND", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    sessionApp.createSessionImpl = async () => {
      throw new AgentSessionRfqNotFoundError(RFQ_ID);
    };
    const orchestrator = new FakeAgentOrchestrator();
    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID, message: "hi" }));

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "RFQ_NOT_FOUND");
    assert.equal(orchestrator.runCalls.length, 0);
  });

  it("maps AgentSessionNotFoundError to 404 SESSION_NOT_FOUND", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    sessionApp.getSessionImpl = async () => {
      throw new AgentSessionNotFoundError(SESSION_ID);
    };
    const orchestrator = new FakeAgentOrchestrator();
    const res = await handleAgentRequest(
      { sessionApp, orchestrator },
      jsonRequest({ sessionId: SESSION_ID, message: "hi" }),
    );

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "SESSION_NOT_FOUND");
    assert.equal(orchestrator.runCalls.length, 0);
  });
});

describe("POST /api/agent: terminal session (409)", () => {
  it("returns 409 SESSION_NOT_RUNNING for a COMPLETED session and never calls the orchestrator", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    sessionApp.getSessionImpl = async () => makeSession({ status: "COMPLETED", endedAt: "2026-01-01T00:05:00.000Z" });
    const orchestrator = new FakeAgentOrchestrator();

    const res = await handleAgentRequest(
      { sessionApp, orchestrator },
      jsonRequest({ sessionId: SESSION_ID, message: "hi" }),
    );

    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.equal(payload.error.code, "SESSION_NOT_RUNNING");
    assert.equal(orchestrator.runCalls.length, 0);
  });
});

describe("POST /api/agent: orchestrator results pass through as 200", () => {
  it("returns 200 with a waiting_for_approval result", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    orchestrator.runImpl = async (input) => ({
      status: "waiting_for_approval",
      sessionId: input.session.id,
      iterations: 1,
      toolName: "create_payment",
      toolCallId: "call_0",
      input: {},
      message: "pending approval",
    });

    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID, message: "pay" }));

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.result.status, "waiting_for_approval");
  });

  it("returns 200 with a max_iterations_reached result", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    orchestrator.runImpl = async (input) => ({
      status: "max_iterations_reached",
      sessionId: input.session.id,
      iterations: 8,
    });

    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID, message: "hi" }));

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.result.status, "max_iterations_reached");
  });

  it("returns 200 with an error result (the orchestrator's own internal failure, not an HTTP failure)", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    orchestrator.runImpl = async (input) => ({
      status: "error",
      sessionId: input.session.id,
      iterations: 1,
      message: "The agent run failed unexpectedly. Please try again.",
    });

    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID, message: "hi" }));

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.result.status, "error");
  });
});

describe("POST /api/agent: unexpected internal failure (500, no internal leak)", () => {
  it("maps an AgentSessionPersistenceError to 500 without leaking its message", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const secret = "duplicate key value violates unique constraint";
    sessionApp.createSessionImpl = async () => {
      throw new AgentSessionPersistenceError("insert", secret);
    };
    const orchestrator = new FakeAgentOrchestrator();

    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID, message: "hi" }));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });

  it("maps an unexpected throw from the orchestrator itself to 500 without leaking its message", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    const secret = "unexpected null pointer in provider adapter";
    orchestrator.runImpl = async () => {
      throw new Error(secret);
    };

    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID, message: "hi" }));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });
});

describe("POST /api/agent: AI service not configured (503, post-Phase-12 regression)", () => {
  /**
   * Regression test for the post-Phase-12 demo-UX pass: route.ts's real
   * POST() constructs createSupabaseAgentOrchestrator() -- which calls
   * createGeminiModelProvider(), which throws GeminiProviderError
   * synchronously when GEMINI_API_KEY is unset/empty -- and now wraps that
   * construction in a try/catch routed through this same
   * mapAgentErrorToResponse(). That construction step itself isn't
   * reachable through handleAgentRequest's fake-deps seam (POST() builds
   * deps before handleAgentRequest ever runs), so this test exercises the
   * shared mapper the same way route.ts's new try/catch does: by making a
   * fake dependency throw GeminiProviderError and asserting the resulting
   * response is the safe, buyer-facing 503 -- not a leak of the provider's
   * own developer-oriented message, and not the generic 500 text.
   */
  it("maps a GeminiProviderError to 503 AI_SERVICE_NOT_CONFIGURED with a buyer-facing message", async () => {
    const sessionApp = new FakeAgentSessionApplication();
    const orchestrator = new FakeAgentOrchestrator();
    orchestrator.runImpl = async () => {
      throw new GeminiProviderError(
        "GEMINI_API_KEY is not set. Add it to your environment (see .env.example) before using the Gemini model provider.",
      );
    };

    const res = await handleAgentRequest({ sessionApp, orchestrator }, jsonRequest({ rfqId: RFQ_ID, message: "hi" }));

    assert.equal(res.status, 503);
    const payload = await res.json();
    assert.equal(payload.error.code, "AI_SERVICE_NOT_CONFIGURED");
    assert.equal(payload.error.message, "The AI service isn't configured yet. Add GEMINI_API_KEY to run the live agent.");
    // The provider's own message (implementation-oriented: ".env.example",
    // "the Gemini model provider") must not leak into the client response.
    assert.ok(!JSON.stringify(payload).includes(".env.example"));
  });
});

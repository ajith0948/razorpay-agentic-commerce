import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ApiError, type AgentOrchestratorResult } from "./api-client.ts";
import * as AgentConversation from "./agent-conversation.ts";
import {
  advanceAgentTurnTarget,
  buildRunAgentInput,
  classifyAgentApiError,
  extractOrderIdFromToolInput,
  initialAgentTurnTarget,
  isAgentSessionResumable,
} from "./agent-conversation.ts";

const FINAL: AgentOrchestratorResult = { status: "final", sessionId: "session-1", iterations: 2, text: "Here is your quote." };
const APPROVAL: AgentOrchestratorResult = {
  status: "waiting_for_approval",
  sessionId: "session-1",
  iterations: 3,
  toolName: "create_payment",
  toolCallId: "call-1",
  input: { orderId: "order-1" },
  message: "Order order-1 (50000 INR) is above the merchant's autonomous approval threshold.",
};
const MAX_ITERATIONS: AgentOrchestratorResult = { status: "max_iterations_reached", sessionId: "session-1", iterations: 8 };
const AGENT_ERROR: AgentOrchestratorResult = {
  status: "error",
  sessionId: "session-1",
  iterations: 1,
  message: "The agent run failed unexpectedly. Please try again.",
};
const INVALID_SESSION: AgentOrchestratorResult = {
  status: "invalid_session",
  sessionId: "session-1",
  reason: "session status is COMPLETED, expected RUNNING",
};

describe("initialAgentTurnTarget", () => {
  it("starts with no session and is not resumable", () => {
    assert.deepEqual(initialAgentTurnTarget("rfq-1"), { rfqId: "rfq-1", sessionId: null, resumable: false });
  });
});

describe("isAgentSessionResumable -- mirrors orchestrator.ts's own end-of-run session transitions", () => {
  it("is true only for waiting_for_approval, the one outcome that leaves the session RUNNING", () => {
    assert.equal(isAgentSessionResumable(APPROVAL), true);
  });

  it("is false for final (session transitions to COMPLETED)", () => {
    assert.equal(isAgentSessionResumable(FINAL), false);
  });

  it("is false for max_iterations_reached (session transitions to FAILED)", () => {
    assert.equal(isAgentSessionResumable(MAX_ITERATIONS), false);
  });

  it("is false for error (session transitions to FAILED)", () => {
    assert.equal(isAgentSessionResumable(AGENT_ERROR), false);
  });

  it("is false for invalid_session (was never RUNNING to begin with)", () => {
    assert.equal(isAgentSessionResumable(INVALID_SESSION), false);
  });
});

describe("buildRunAgentInput", () => {
  it("sends rfqId, not sessionId, for a fresh target that has never talked to the agent", () => {
    const target = initialAgentTurnTarget("rfq-1");
    assert.deepEqual(buildRunAgentInput(target, "I need 5000 boxes"), { message: "I need 5000 boxes", rfqId: "rfq-1" });
  });

  it("sends sessionId once the target is resumable", () => {
    const target = { rfqId: "rfq-1", sessionId: "session-1", resumable: true };
    assert.deepEqual(buildRunAgentInput(target, "please continue"), { message: "please continue", sessionId: "session-1" });
  });

  it("falls back to rfqId when a sessionId is known but the session already ended", () => {
    const target = { rfqId: "rfq-1", sessionId: "session-1", resumable: false };
    assert.deepEqual(buildRunAgentInput(target, "hi again"), { message: "hi again", rfqId: "rfq-1" });
  });

  it("never sends both rfqId and sessionId in the same call", () => {
    for (const target of [
      initialAgentTurnTarget("rfq-1"),
      { rfqId: "rfq-1", sessionId: "session-1", resumable: true },
      { rfqId: "rfq-1", sessionId: "session-1", resumable: false },
    ]) {
      const body = buildRunAgentInput(target, "x");
      assert.equal(Boolean(body.rfqId) && Boolean(body.sessionId), false);
    }
  });
});

describe("advanceAgentTurnTarget", () => {
  it("becomes resumable after waiting_for_approval, remembering the new sessionId", () => {
    const target = advanceAgentTurnTarget(initialAgentTurnTarget("rfq-1"), APPROVAL);
    assert.deepEqual(target, { rfqId: "rfq-1", sessionId: "session-1", resumable: true });
  });

  it("is not resumable after final -- the session already completed server-side", () => {
    const target = advanceAgentTurnTarget(initialAgentTurnTarget("rfq-1"), FINAL);
    assert.deepEqual(target, { rfqId: "rfq-1", sessionId: "session-1", resumable: false });
  });

  it("is not resumable after max_iterations_reached -- the session already failed server-side", () => {
    const target = advanceAgentTurnTarget(initialAgentTurnTarget("rfq-1"), MAX_ITERATIONS);
    assert.equal(target.resumable, false);
  });

  it("a resumed session that then goes final stops being resumable again", () => {
    let target = advanceAgentTurnTarget(initialAgentTurnTarget("rfq-1"), APPROVAL);
    assert.equal(target.resumable, true);

    target = advanceAgentTurnTarget(target, FINAL);
    assert.equal(target.resumable, false);
    assert.deepEqual(buildRunAgentInput(target, "one more thing"), { message: "one more thing", rfqId: "rfq-1" });
  });

  it("rfqId never changes across turns, regardless of outcome", () => {
    for (const result of [FINAL, APPROVAL, MAX_ITERATIONS, AGENT_ERROR, INVALID_SESSION]) {
      assert.equal(advanceAgentTurnTarget(initialAgentTurnTarget("rfq-1"), result).rfqId, "rfq-1");
    }
  });
});

describe("classifyAgentApiError", () => {
  it("classifies the synthesized network failure (status 0)", () => {
    const display = classifyAgentApiError(new ApiError(0, "NETWORK_ERROR", "Could not reach the server."));
    assert.equal(display.kind, "network");
  });

  it("classifies 400 as validation", () => {
    const display = classifyAgentApiError(new ApiError(400, "INVALID_REQUEST_BODY", "Request body failed validation."));
    assert.equal(display.kind, "validation");
    assert.equal(display.code, "INVALID_REQUEST_BODY");
  });

  it("classifies 404 as not_found", () => {
    const display = classifyAgentApiError(new ApiError(404, "RFQ_NOT_FOUND", "No such RFQ."));
    assert.equal(display.kind, "not_found");
  });

  it("classifies 409 as session_conflict", () => {
    const display = classifyAgentApiError(new ApiError(409, "SESSION_NOT_RUNNING", "Agent session is not RUNNING."));
    assert.equal(display.kind, "session_conflict");
  });

  it("classifies 500 (and any other status) as server", () => {
    assert.equal(classifyAgentApiError(new ApiError(500, "INTERNAL_ERROR", "boom")).kind, "server");
    assert.equal(classifyAgentApiError(new ApiError(422, "SOMETHING_ELSE", "boom")).kind, "server");
  });

  it("classifies a non-ApiError thrown value as server, without throwing itself", () => {
    const display = classifyAgentApiError(new Error("plain error"));
    assert.equal(display.kind, "server");
    assert.equal(display.code, "UNKNOWN_ERROR");
  });

  it("classifies a non-Error thrown value as server, without throwing itself", () => {
    assert.equal(classifyAgentApiError("just a string").kind, "server");
    assert.equal(classifyAgentApiError(undefined).kind, "server");
  });
});

describe("extractOrderIdFromToolInput", () => {
  it("reads orderId out of a create_payment-shaped input", () => {
    assert.equal(extractOrderIdFromToolInput({ orderId: "order-1" }), "order-1");
  });

  it("returns null when the input has no orderId field", () => {
    assert.equal(extractOrderIdFromToolInput({ quoteId: "quote-1" }), null);
  });

  it("returns null for a non-string orderId, rather than coercing it", () => {
    assert.equal(extractOrderIdFromToolInput({ orderId: 123 }), null);
  });

  it("returns null for null/undefined/primitive input, without throwing", () => {
    assert.equal(extractOrderIdFromToolInput(null), null);
    assert.equal(extractOrderIdFromToolInput(undefined), null);
    assert.equal(extractOrderIdFromToolInput("orderId"), null);
    assert.equal(extractOrderIdFromToolInput(42), null);
  });
});

describe("boundary integrity: the buyer-facing agent conversation module exposes no approval-decision capability", () => {
  it("has no export whose name suggests approving/rejecting -- that stays exclusively the merchant's ApprovalPanel/api-client functions", () => {
    const suspicious = Object.keys(AgentConversation).filter((name) => /approve|reject/i.test(name));
    assert.deepEqual(suspicious, []);
  });
});

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  createRfq,
  getRfq,
  getQuote,
  acceptQuote,
  createOrder,
  getOrder,
  createPayment,
  getPayment,
  createApproval,
  approveApproval,
  rejectApproval,
  runAgent,
} from "./api-client.ts";
import * as ApiClient from "./api-client.ts";
import {
  RFQ_STATUSES,
  QUOTE_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  APPROVAL_STATUSES,
} from "../state-machine/types.ts";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setResponse(status: number, body: unknown): void {
  nextResponse = { status, body };
}

function bodyOf(call: FetchCall): unknown {
  return call.init?.body === undefined ? undefined : JSON.parse(call.init.body as string);
}

describe("api-client: each function calls the correct endpoint", () => {
  it("createRfq() posts to /api/rfqs with exactly the given input", async () => {
    setResponse(201, { rfq: { id: "rfq-1" } });
    await createRfq({ merchantId: "m1", buyerId: "b1", rawRequest: "need boxes" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/rfqs");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(bodyOf(calls[0]), {
      merchantId: "m1",
      buyerId: "b1",
      rawRequest: "need boxes",
    });
  });

  it("getRfq() gets /api/rfqs/:id, URI-encoding the id", async () => {
    setResponse(200, { rfq: { id: "rfq 1" } });
    await getRfq("rfq 1");

    assert.equal(calls[0].url, "/api/rfqs/rfq%201");
    assert.equal(calls[0].init?.method, undefined);
  });

  it("getQuote() gets /api/quotes/:id", async () => {
    setResponse(200, { quote: { id: "quote-1" } });
    await getQuote("quote-1");

    assert.equal(calls[0].url, "/api/quotes/quote-1");
    assert.equal(calls[0].init?.method, undefined);
  });

  it("acceptQuote() posts to /api/quotes/:id/accept with no request body", async () => {
    setResponse(200, { quote: { id: "quote-1", status: "ACCEPTED" } });
    await acceptQuote("quote-1");

    assert.equal(calls[0].url, "/api/quotes/quote-1/accept");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, undefined);
  });

  it("createOrder() posts to /api/orders with exactly {quoteId}", async () => {
    setResponse(201, { order: { id: "order-1" } });
    await createOrder({ quoteId: "quote-1" });

    assert.equal(calls[0].url, "/api/orders");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(bodyOf(calls[0]), { quoteId: "quote-1" });
  });

  it("getOrder() gets /api/orders/:id", async () => {
    setResponse(200, { order: { id: "order-1" } });
    await getOrder("order-1");

    assert.equal(calls[0].url, "/api/orders/order-1");
  });

  it("createPayment() posts to /api/payments with {orderId}, and the demo Payment comes back CREATED", async () => {
    setResponse(201, { payment: { id: "payment-1", status: "CREATED" } });
    const { payment } = await createPayment({ orderId: "order-1" });

    assert.equal(calls[0].url, "/api/payments");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(bodyOf(calls[0]), { orderId: "order-1" });
    assert.equal(payment.status, "CREATED");
  });

  it("getPayment() gets /api/payments/:id", async () => {
    setResponse(200, { payment: { id: "payment-1" } });
    await getPayment("payment-1");

    assert.equal(calls[0].url, "/api/payments/payment-1");
  });

  it("createApproval() posts to /api/approvals with exactly {quoteId, reason}", async () => {
    setResponse(201, { approval: { id: "approval-1" } });
    await createApproval({ quoteId: "quote-1", reason: "exceeds autonomous discount limit" });

    assert.equal(calls[0].url, "/api/approvals");
    assert.deepEqual(bodyOf(calls[0]), {
      quoteId: "quote-1",
      reason: "exceeds autonomous discount limit",
    });
  });

  it("approveApproval() posts to /api/approvals/:id/approve, omitting the body when approvedBy is not given", async () => {
    setResponse(200, { approval: { id: "approval-1", status: "APPROVED" } });
    await approveApproval("approval-1");

    assert.equal(calls[0].url, "/api/approvals/approval-1/approve");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, undefined);
  });

  it("approveApproval() includes {approvedBy} in the body when given", async () => {
    setResponse(200, { approval: { id: "approval-1", status: "APPROVED" } });
    await approveApproval("approval-1", "demo-merchant");

    assert.deepEqual(bodyOf(calls[0]), { approvedBy: "demo-merchant" });
  });

  it("rejectApproval() posts to /api/approvals/:id/reject", async () => {
    setResponse(200, { approval: { id: "approval-1", status: "REJECTED" } });
    await rejectApproval("approval-1");

    assert.equal(calls[0].url, "/api/approvals/approval-1/reject");
    assert.equal(calls[0].init?.method, "POST");
  });

  it("runAgent() posts to /api/agent with {message, rfqId} to start a new session", async () => {
    setResponse(200, { result: { status: "final", sessionId: "session-1", iterations: 1, text: "Understood." } });
    await runAgent({ message: "I need 5000 boxes", rfqId: "rfq-1" });

    assert.equal(calls[0].url, "/api/agent");
    assert.equal(calls[0].init?.method, "POST");
    assert.deepEqual(bodyOf(calls[0]), { message: "I need 5000 boxes", rfqId: "rfq-1" });
  });

  it("runAgent() posts to /api/agent with {message, sessionId} to continue an existing session", async () => {
    setResponse(200, { result: { status: "final", sessionId: "session-1", iterations: 1, text: "Done." } });
    await runAgent({ message: "please continue", sessionId: "session-1" });

    assert.deepEqual(bodyOf(calls[0]), { message: "please continue", sessionId: "session-1" });
  });

  it("runAgent() returns the result envelope exactly as the server sent it, whatever result.status is", async () => {
    const waitingForApproval = {
      status: "waiting_for_approval",
      sessionId: "session-1",
      iterations: 2,
      toolName: "create_payment",
      toolCallId: "call-1",
      input: { orderId: "order-1" },
      message: "Order order-1 (50000 INR) is above the merchant's autonomous approval threshold.",
    };
    setResponse(200, { result: waitingForApproval });

    const { result } = await runAgent({ message: "please pay", sessionId: "session-1" });
    assert.deepEqual(result, waitingForApproval);
  });
});

describe("api-client: error handling (what the UI has available to display)", () => {
  it("throws an ApiError carrying the server's own code/message for a non-2xx response", async () => {
    setResponse(409, {
      error: { code: "TRANSITION_CONFLICT", message: "The Quote could not be transitioned from its current state." },
    });

    await assert.rejects(
      () => acceptQuote("quote-1"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, "TRANSITION_CONFLICT");
        assert.equal(err.message, "The Quote could not be transitioned from its current state.");
        return true;
      },
    );
  });

  it("carries extra server-supplied error fields (e.g. rfqId, missingFields) as details", async () => {
    setResponse(422, {
      error: {
        code: "RFQ_REQUIREMENTS_INCOMPLETE",
        message: "The RFQ could not be parsed into structured requirements.",
        rfqId: "rfq-1",
        missingFields: ["quantity"],
      },
    });

    await assert.rejects(
      () => createRfq({ merchantId: "m1", buyerId: "b1", rawRequest: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.deepEqual(err.details, { rfqId: "rfq-1", missingFields: ["quantity"] });
        return true;
      },
    );
  });

  it("falls back to a safe default code/message when the error body is missing or malformed", async () => {
    setResponse(500, {});

    await assert.rejects(
      () => getOrder("order-1"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, "UNKNOWN_ERROR");
        assert.match(err.message, /500/);
        return true;
      },
    );
  });

  it("throws a NETWORK_ERROR ApiError when fetch() itself rejects, instead of an uncaught exception", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    await assert.rejects(
      () => getRfq("rfq-1"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, "NETWORK_ERROR");
        return true;
      },
    );
  });

  it("runAgent() surfaces a 409 SESSION_NOT_RUNNING as an ApiError the UI can distinguish from other failures", async () => {
    setResponse(409, {
      error: {
        code: "SESSION_NOT_RUNNING",
        message: "Agent session session-1 is not RUNNING (status: COMPLETED).",
        sessionId: "session-1",
        status: "COMPLETED",
      },
    });

    await assert.rejects(
      () => runAgent({ message: "one more thing", sessionId: "session-1" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, "SESSION_NOT_RUNNING");
        assert.deepEqual(err.details, { sessionId: "session-1", status: "COMPLETED" });
        return true;
      },
    );
  });
});

describe("api-client: never exposes a payment mark-paid capability", () => {
  it("has no runtime export beyond createPayment/getPayment whose name suggests paying/marking-paid", () => {
    const paymentRelated = Object.keys(ApiClient).filter((name) => /pay/i.test(name));
    assert.deepEqual(paymentRelated.sort(), ["createPayment", "getPayment"]);
  });
});

describe("api-client: status values mirror the real state machine exactly (no invented UI-only states)", () => {
  // api-client.ts's RfqStatus/QuoteStatus/OrderStatus/PaymentStatus/
  // ApprovalStatus are hand-copied type-only unions (this module must not
  // import lib/state-machine at runtime -- see its own header comment).
  // These literal arrays are that same set of values, spelled out so this
  // test can diff them against the real *_STATUSES arrays at runtime and
  // catch any drift or invented status immediately.
  const UI_RFQ_STATUSES = [
    "CREATED",
    "PROCESSING",
    "QUOTED",
    "NEGOTIATING",
    "ACCEPTED",
    "REJECTED",
    "EXPIRED",
    "CANCELLED",
    "FAILED",
  ];
  const UI_QUOTE_STATUSES = ["DRAFT", "SENT", "NEGOTIATING", "ACCEPTED", "EXPIRED", "REJECTED"];
  const UI_ORDER_STATUSES = [
    "CREATED",
    "PAYMENT_PENDING",
    "PAID",
    "CONFIRMED",
    "PAYMENT_FAILED",
    "CANCELLED",
  ];
  const UI_PAYMENT_STATUSES = ["CREATED", "PENDING", "PAID", "FAILED"];
  const UI_APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"];

  it("RfqStatus matches RFQ_STATUSES", () => {
    assert.deepEqual([...UI_RFQ_STATUSES].sort(), [...RFQ_STATUSES].sort());
  });

  it("QuoteStatus matches QUOTE_STATUSES", () => {
    assert.deepEqual([...UI_QUOTE_STATUSES].sort(), [...QUOTE_STATUSES].sort());
  });

  it("OrderStatus matches ORDER_STATUSES", () => {
    assert.deepEqual([...UI_ORDER_STATUSES].sort(), [...ORDER_STATUSES].sort());
  });

  it("PaymentStatus matches PAYMENT_STATUSES", () => {
    assert.deepEqual([...UI_PAYMENT_STATUSES].sort(), [...PAYMENT_STATUSES].sort());
  });

  it("ApprovalStatus matches APPROVAL_STATUSES", () => {
    assert.deepEqual([...UI_APPROVAL_STATUSES].sort(), [...APPROVAL_STATUSES].sort());
  });
});

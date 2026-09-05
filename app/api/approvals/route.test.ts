import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleCreateApproval } from "./route.ts";
import type { ApprovalApplication } from "../../../lib/approval/index.ts";
import {
  ApprovalPersistenceError,
  ApprovalQuoteNotFoundError,
  ApprovalValidationError,
} from "../../../lib/approval/index.ts";
import type { Approval, CreateApprovalInput } from "../../../lib/approval/types.ts";

const QUOTE_ID = "quote-1";
const MERCHANT_ID = "merchant-1";
const RFQ_ID = "rfq-1";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    merchantId: MERCHANT_ID,
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    requestedAmount: 114000,
    reason: "Discount exceeds autonomous limit",
    status: "PENDING",
    approvedBy: null,
    approvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Fake ApprovalApplication -- this route only ever calls createApproval().
 * Every other method throws if reached, so a test would fail loudly (not
 * silently pass) if the route ever started calling a method it has no
 * business calling -- in particular, this proves POST /api/approvals never
 * dispatches a lifecycle transition merely because an Approval was created.
 */
class FakeApprovalApplication implements ApprovalApplication {
  createApprovalCalls: CreateApprovalInput[] = [];
  createApprovalImpl: (input: CreateApprovalInput) => Promise<Approval> = async (input) =>
    makeApproval({ quoteId: input.quoteId, reason: input.reason });

  async createApproval(input: CreateApprovalInput): Promise<Approval> {
    this.createApprovalCalls.push(input);
    return this.createApprovalImpl(input);
  }

  async getApprovalById(): Promise<Approval> {
    throw new Error(
      "FakeApprovalApplication: getApprovalById() should not be called by POST /api/approvals",
    );
  }

  async getLatestApprovalByQuoteId(): Promise<Approval | null> {
    throw new Error(
      "FakeApprovalApplication: getLatestApprovalByQuoteId() should not be called by POST /api/approvals",
    );
  }

  async transitionApprovalStatus(): Promise<Approval> {
    throw new Error(
      "FakeApprovalApplication: transitionApprovalStatus() should not be called by POST /api/approvals " +
        "-- creating an Approval must never itself dispatch a lifecycle transition.",
    );
  }
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(rawBody: string): Request {
  return new Request("http://localhost/api/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

const VALID_BODY = { quoteId: QUOTE_ID, reason: "Discount exceeds autonomous limit" };

describe("POST /api/approvals: success", () => {
  it("returns 201 with the created Approval, status PENDING", async () => {
    const app = new FakeApprovalApplication();
    const res = await handleCreateApproval(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.approval.quoteId, QUOTE_ID);
    assert.equal(payload.approval.status, "PENDING");
  });

  it("calls createApproval() exactly once, with the parsed request body", async () => {
    const app = new FakeApprovalApplication();
    await handleCreateApproval(app, jsonRequest(VALID_BODY));

    assert.deepEqual(app.createApprovalCalls, [VALID_BODY]);
  });
});

describe("POST /api/approvals: missing quote (404)", () => {
  it("maps ApprovalQuoteNotFoundError to 404 QUOTE_NOT_FOUND", async () => {
    const app = new FakeApprovalApplication();
    app.createApprovalImpl = async () => {
      throw new ApprovalQuoteNotFoundError(QUOTE_ID);
    };

    const res = await handleCreateApproval(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "QUOTE_NOT_FOUND");
  });
});

describe("POST /api/approvals: request validation (400)", () => {
  it("returns 400 INVALID_REQUEST_BODY for malformed JSON", async () => {
    const app = new FakeApprovalApplication();
    const res = await handleCreateApproval(app, rawRequest("{not json"));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createApprovalCalls.length, 0);
  });

  it("returns 400 INVALID_REQUEST_BODY when reason is missing", async () => {
    const app = new FakeApprovalApplication();
    const res = await handleCreateApproval(app, jsonRequest({ quoteId: QUOTE_ID }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createApprovalCalls.length, 0);
  });

  it("maps ApprovalValidationError to 400 VALIDATION_ERROR", async () => {
    const app = new FakeApprovalApplication();
    app.createApprovalImpl = async () => {
      throw new ApprovalValidationError("reason", "is required");
    };

    const res = await handleCreateApproval(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "VALIDATION_ERROR");
  });
});

describe("POST /api/approvals: persistence failure (500, no internal leak)", () => {
  it("maps an ApprovalPersistenceError to 500 without leaking its message", async () => {
    const app = new FakeApprovalApplication();
    const secret = "duplicate key value violates unique constraint";
    app.createApprovalImpl = async () => {
      throw new ApprovalPersistenceError("insert", secret);
    };

    const res = await handleCreateApproval(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });
});

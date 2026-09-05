/**
 * Tests for POST /api/approvals/:id/approve
 * (app/api/approvals/[id]/approve/route.ts). This file deliberately lives
 * here, two directories up from the route it tests, rather than alongside
 * it -- same bracket-glob reasoning as
 * app/api/quotes/quote-id-route.test.ts's own header comment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleApproveApproval } from "./[id]/approve/route.ts";
import type { ApprovalApplication } from "../../../lib/approval/index.ts";
import {
  ApprovalNotFoundError,
  ApprovalPersistenceError,
} from "../../../lib/approval/index.ts";
import type { TransitionApprovalStatusInput } from "../../../lib/approval/application.ts";
import { InvalidTransitionError } from "../../../lib/state-machine/index.ts";
import type { Approval } from "../../../lib/approval/types.ts";

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    merchantId: "merchant-1",
    rfqId: "rfq-1",
    quoteId: "quote-1",
    requestedAmount: 114000,
    reason: "Discount exceeds autonomous limit",
    status: "PENDING",
    approvedBy: null,
    approvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/approvals/approval-1/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function emptyRequest(): Request {
  return new Request("http://localhost/api/approvals/approval-1/approve", { method: "POST" });
}

function rawRequest(rawBody: string): Request {
  return new Request("http://localhost/api/approvals/approval-1/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

/**
 * Fake ApprovalApplication -- this route only ever calls getApprovalById()
 * then transitionApprovalStatus(). createApproval()/
 * getLatestApprovalByQuoteId() throw if reached.
 */
class FakeApprovalApplication implements ApprovalApplication {
  getApprovalByIdCalls: string[] = [];
  getApprovalByIdImpl: (approvalId: string) => Promise<Approval> = async (approvalId) =>
    makeApproval({ id: approvalId });

  transitionApprovalStatusCalls: TransitionApprovalStatusInput[] = [];
  transitionApprovalStatusImpl: (params: TransitionApprovalStatusInput) => Promise<Approval> =
    async (params) => makeApproval({ id: params.approvalId, status: params.to, approvedBy: params.approvedBy ?? null });

  async createApproval(): Promise<Approval> {
    throw new Error(
      "FakeApprovalApplication: createApproval() should not be called by POST /api/approvals/:id/approve",
    );
  }

  async getApprovalById(approvalId: string): Promise<Approval> {
    this.getApprovalByIdCalls.push(approvalId);
    return this.getApprovalByIdImpl(approvalId);
  }

  async getLatestApprovalByQuoteId(): Promise<Approval | null> {
    throw new Error(
      "FakeApprovalApplication: getLatestApprovalByQuoteId() should not be called by POST /api/approvals/:id/approve",
    );
  }

  async transitionApprovalStatus(params: TransitionApprovalStatusInput): Promise<Approval> {
    this.transitionApprovalStatusCalls.push(params);
    return this.transitionApprovalStatusImpl(params);
  }
}

describe("POST /api/approvals/:id/approve: success", () => {
  it("returns 200 with the approved Approval", async () => {
    const app = new FakeApprovalApplication();
    const res = await handleApproveApproval(app, "approval-1", emptyRequest());

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.approval.id, "approval-1");
    assert.equal(payload.approval.status, "APPROVED");
  });

  it("reads the current Approval, then transitions PENDING -> APPROVED as HUMAN_MERCHANT", async () => {
    const app = new FakeApprovalApplication();
    app.getApprovalByIdImpl = async (approvalId) =>
      makeApproval({
        id: approvalId,
        status: "PENDING",
        merchantId: "merchant-9",
        rfqId: "rfq-9",
        quoteId: "quote-9",
      });

    await handleApproveApproval(app, "approval-1", emptyRequest());

    assert.deepEqual(app.getApprovalByIdCalls, ["approval-1"]);
    assert.equal(app.transitionApprovalStatusCalls.length, 1);
    assert.deepEqual(app.transitionApprovalStatusCalls[0], {
      approvalId: "approval-1",
      from: "PENDING",
      to: "APPROVED",
      merchantId: "merchant-9",
      rfqId: "rfq-9",
      quoteId: "quote-9",
      actorType: "HUMAN_MERCHANT",
      approvedBy: undefined,
    });
  });

  it("passes an optional caller-supplied approvedBy straight through", async () => {
    const app = new FakeApprovalApplication();
    await handleApproveApproval(app, "approval-1", jsonRequest({ approvedBy: "merchant-user-1" }));

    assert.equal(app.transitionApprovalStatusCalls[0].approvedBy, "merchant-user-1");
  });
});

describe("POST /api/approvals/:id/approve: invalid transition (409)", () => {
  it("maps InvalidTransitionError (e.g. already APPROVED/REJECTED) to 409 TRANSITION_CONFLICT", async () => {
    const app = new FakeApprovalApplication();
    app.getApprovalByIdImpl = async (approvalId) =>
      makeApproval({ id: approvalId, status: "APPROVED" });
    app.transitionApprovalStatusImpl = async () => {
      throw new InvalidTransitionError("approval", "APPROVED", "APPROVED");
    };

    const res = await handleApproveApproval(app, "approval-1", emptyRequest());

    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.equal(payload.error.code, "TRANSITION_CONFLICT");
  });
});

describe("POST /api/approvals/:id/approve: missing approval (404)", () => {
  it("maps ApprovalNotFoundError to 404 APPROVAL_NOT_FOUND and never attempts a transition", async () => {
    const app = new FakeApprovalApplication();
    app.getApprovalByIdImpl = async () => {
      throw new ApprovalNotFoundError("approval-1");
    };

    const res = await handleApproveApproval(app, "approval-1", emptyRequest());

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "APPROVAL_NOT_FOUND");
    assert.equal(app.transitionApprovalStatusCalls.length, 0);
  });
});

describe("POST /api/approvals/:id/approve: request validation (400)", () => {
  it("returns 400 INVALID_REQUEST_BODY for malformed non-empty JSON", async () => {
    const app = new FakeApprovalApplication();
    const res = await handleApproveApproval(app, "approval-1", rawRequest("{not json"));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.getApprovalByIdCalls.length, 0);
  });
});

describe("POST /api/approvals/:id/approve: application error mapping (500, no internal leak)", () => {
  it("maps an ApprovalPersistenceError to 500 without leaking its message", async () => {
    const app = new FakeApprovalApplication();
    const secret = "duplicate key value violates unique constraint";
    app.getApprovalByIdImpl = async () => {
      throw new ApprovalPersistenceError("select", secret);
    };

    const res = await handleApproveApproval(app, "approval-1", emptyRequest());

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });
});

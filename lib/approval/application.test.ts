import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createApprovalApplication } from "./application.ts";
import type { ApprovalDbClient, ApprovalRow, NewApprovalRow, QuoteRefRow } from "./db.ts";
import { toApprovalDbClient } from "./supabase-approval-db.ts";
import {
  ApprovalNotFoundError,
  ApprovalPersistenceError,
  ApprovalQuoteNotFoundError,
  ApprovalValidationError,
} from "./errors.ts";
import type { PostgrestResult } from "../state-machine/index.ts";
import { createStateRuntime } from "../runtime/index.ts";
import { FakeStatusDb } from "../state-machine/test-support.ts";
import { InvalidTransitionError, StaleTransitionError } from "../state-machine/errors.ts";

const MERCHANT_ID = "merchant-1";
const RFQ_ID = "rfq-1";
const QUOTE_ID = "quote-1";

/**
 * Self-contained in-memory fake of ApprovalDbClient -- same spirit as
 * lib/order/application.test.ts's FakeOrderDb.
 */
class FakeApprovalDb implements ApprovalDbClient {
  private readonly approvals = new Map<string, ApprovalRow>();
  private readonly quotes = new Map<string, QuoteRefRow>();
  private nextId = 1;
  insertError: { message: string } | null = null;
  selectError: { message: string } | null = null;
  quoteSelectError: { message: string } | null = null;
  latestSelectError: { message: string } | null = null;

  seedApproval(row: ApprovalRow): void {
    this.approvals.set(row.id, row);
  }

  seedQuote(row: QuoteRefRow): void {
    this.quotes.set(row.id, row);
  }

  insertApproval(row: NewApprovalRow): PromiseLike<PostgrestResult<ApprovalRow>> {
    if (this.insertError) {
      return Promise.resolve({ data: null, error: this.insertError });
    }
    const now = new Date().toISOString();
    const stored: ApprovalRow = {
      id: `approval-${this.nextId++}`,
      merchant_id: row.merchant_id,
      rfq_id: row.rfq_id,
      quote_id: row.quote_id,
      requested_amount: row.requested_amount,
      reason: row.reason,
      status: "PENDING",
      approved_by: null,
      approved_at: null,
      created_at: now,
    };
    this.approvals.set(stored.id, stored);
    return Promise.resolve({ data: stored, error: null });
  }

  getApprovalById(id: string): PromiseLike<PostgrestResult<ApprovalRow>> {
    if (this.selectError) {
      return Promise.resolve({ data: null, error: this.selectError });
    }
    return Promise.resolve({ data: this.approvals.get(id) ?? null, error: null });
  }

  getQuoteRef(quoteId: string): PromiseLike<PostgrestResult<QuoteRefRow>> {
    if (this.quoteSelectError) {
      return Promise.resolve({ data: null, error: this.quoteSelectError });
    }
    return Promise.resolve({ data: this.quotes.get(quoteId) ?? null, error: null });
  }

  getLatestApprovalByQuoteId(quoteId: string): PromiseLike<PostgrestResult<ApprovalRow>> {
    if (this.latestSelectError) {
      return Promise.resolve({ data: null, error: this.latestSelectError });
    }
    let latest: ApprovalRow | null = null;
    for (const approval of this.approvals.values()) {
      if (approval.quote_id !== quoteId) continue;
      if (!latest || approval.created_at > latest.created_at) {
        latest = approval;
      }
    }
    return Promise.resolve({ data: latest, error: null });
  }
}

/**
 * Adapts a FakeStatusDb's own "approvals" table to ApprovalDbClient --
 * mirrors lib/order/application.test.ts's orderDbFromStatusDb(). Used only
 * by the lifecycle tests below, which never call createApproval(), so the
 * creation/quote-ref methods are unreachable stubs.
 */
function approvalDbFromStatusDb(statusDb: FakeStatusDb): ApprovalDbClient {
  return {
    insertApproval: () => {
      throw new Error("approvalDbFromStatusDb: insertApproval() should not be called by lifecycle tests");
    },
    getApprovalById: (id) => {
      const row = statusDb.getRow("approvals", id);
      return Promise.resolve({ data: (row ?? null) as unknown as ApprovalRow | null, error: null });
    },
    getQuoteRef: () => {
      throw new Error("approvalDbFromStatusDb: getQuoteRef() should not be called by lifecycle tests");
    },
    getLatestApprovalByQuoteId: () => {
      throw new Error(
        "approvalDbFromStatusDb: getLatestApprovalByQuoteId() should not be called by lifecycle tests",
      );
    },
  };
}

function makeApp(db: ApprovalDbClient = new FakeApprovalDb(), statusDb: FakeStatusDb = new FakeStatusDb()) {
  const runtime = createStateRuntime(statusDb);
  return { app: createApprovalApplication({ db, runtime }) };
}

const VALID_INPUT = { quoteId: QUOTE_ID, reason: "Order value exceeds autonomous approval limit" };

function seedQuote(db: FakeApprovalDb, overrides: Partial<QuoteRefRow> = {}): void {
  db.seedQuote({
    id: QUOTE_ID,
    merchant_id: MERCHANT_ID,
    rfq_id: RFQ_ID,
    total_amount: 114000,
    ...overrides,
  });
}

describe("createApproval", () => {
  it("creates a valid Approval, deriving merchantId/rfqId/requestedAmount from the referenced Quote", async () => {
    const db = new FakeApprovalDb();
    seedQuote(db);
    const { app } = makeApp(db);

    const approval = await app.createApproval(VALID_INPUT);

    assert.equal(approval.quoteId, QUOTE_ID);
    assert.equal(approval.rfqId, RFQ_ID);
    assert.equal(approval.merchantId, MERCHANT_ID);
    assert.equal(approval.requestedAmount, 114000);
    assert.equal(approval.reason, VALID_INPUT.reason);
    assert.equal(typeof approval.id, "string");
    assert.equal(typeof approval.createdAt, "string");
  });

  it("establishes PENDING as the initial state, without the caller supplying it", async () => {
    const db = new FakeApprovalDb();
    seedQuote(db);
    const { app } = makeApp(db);

    const approval = await app.createApproval(VALID_INPUT);
    assert.equal(approval.status, "PENDING");
    assert.equal(approval.approvedBy, null);
    assert.equal(approval.approvedAt, null);
  });

  it("does not accept a caller-supplied amount -- the amount always comes from the Quote", async () => {
    const db = new FakeApprovalDb();
    seedQuote(db, { total_amount: 250000 });
    const { app } = makeApp(db);

    const approval = await app.createApproval({
      quoteId: QUOTE_ID,
      reason: "attempted override",
      // @ts-expect-error -- requestedAmount is intentionally not part of CreateApprovalInput
      requestedAmount: 1,
    });

    assert.equal(approval.requestedAmount, 250000);
  });

  it("rejects a missing quoteId with ApprovalValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(
      () => app.createApproval({ quoteId: "", reason: "x" }),
      ApprovalValidationError,
    );
  });

  it("rejects a missing reason with ApprovalValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(
      () => app.createApproval({ quoteId: QUOTE_ID, reason: "" }),
      ApprovalValidationError,
    );
  });

  it("rejects creation against a nonexistent Quote with ApprovalQuoteNotFoundError", async () => {
    const { app } = makeApp(new FakeApprovalDb());
    await assert.rejects(() => app.createApproval(VALID_INPUT), ApprovalQuoteNotFoundError);
  });

  it("surfaces a Quote-lookup database failure as ApprovalPersistenceError", async () => {
    const db = new FakeApprovalDb();
    db.quoteSelectError = { message: "connection reset" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createApproval(VALID_INPUT), ApprovalPersistenceError);
  });

  it("surfaces an insert failure as ApprovalPersistenceError", async () => {
    const db = new FakeApprovalDb();
    seedQuote(db);
    db.insertError = { message: "duplicate key value violates unique constraint" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createApproval(VALID_INPUT), ApprovalPersistenceError);
  });
});

describe("getApprovalById", () => {
  it("returns an existing Approval", async () => {
    const db = new FakeApprovalDb();
    db.seedApproval({
      id: "approval-1",
      merchant_id: MERCHANT_ID,
      rfq_id: RFQ_ID,
      quote_id: QUOTE_ID,
      requested_amount: 114000,
      reason: "over limit",
      status: "PENDING",
      approved_by: null,
      approved_at: null,
      created_at: new Date().toISOString(),
    });
    const { app } = makeApp(db);

    const approval = await app.getApprovalById("approval-1");
    assert.equal(approval.id, "approval-1");
  });

  it("throws ApprovalNotFoundError (not a null return) for a missing id", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.getApprovalById("does-not-exist"), ApprovalNotFoundError);
  });

  it("surfaces a database failure as ApprovalPersistenceError", async () => {
    const db = new FakeApprovalDb();
    db.selectError = { message: "timeout" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.getApprovalById("approval-1"), ApprovalPersistenceError);
  });
});

describe("getLatestApprovalByQuoteId", () => {
  it("returns null when no Approval exists for the quote", async () => {
    const { app } = makeApp();
    assert.equal(await app.getLatestApprovalByQuoteId(QUOTE_ID), null);
  });

  it("returns the most recently created Approval when several exist", async () => {
    const db = new FakeApprovalDb();
    db.seedApproval({
      id: "approval-old",
      merchant_id: MERCHANT_ID,
      rfq_id: RFQ_ID,
      quote_id: QUOTE_ID,
      requested_amount: 100,
      reason: "old",
      status: "REJECTED",
      approved_by: "merchant-owner",
      approved_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    db.seedApproval({
      id: "approval-new",
      merchant_id: MERCHANT_ID,
      rfq_id: RFQ_ID,
      quote_id: QUOTE_ID,
      requested_amount: 200,
      reason: "new",
      status: "PENDING",
      approved_by: null,
      approved_at: null,
      created_at: "2026-01-02T00:00:00.000Z",
    });
    const { app } = makeApp(db);

    const latest = await app.getLatestApprovalByQuoteId(QUOTE_ID);
    assert.equal(latest?.id, "approval-new");
  });
});

describe("transitionApprovalStatus", () => {
  it("allows PENDING -> APPROVED", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("approvals", { id: "approval-1", status: "PENDING" });
    const { app } = makeApp(approvalDbFromStatusDb(statusDb), statusDb);

    const approval = await app.transitionApprovalStatus({
      approvalId: "approval-1",
      from: "PENDING",
      to: "APPROVED",
      merchantId: MERCHANT_ID,
      actorType: "HUMAN_MERCHANT",
      approvedBy: "merchant-owner",
    });

    assert.equal(approval.status, "APPROVED");
  });

  it("allows PENDING -> REJECTED", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("approvals", { id: "approval-1", status: "PENDING" });
    const { app } = makeApp(approvalDbFromStatusDb(statusDb), statusDb);

    const approval = await app.transitionApprovalStatus({
      approvalId: "approval-1",
      from: "PENDING",
      to: "REJECTED",
      merchantId: MERCHANT_ID,
      actorType: "HUMAN_MERCHANT",
      approvedBy: "merchant-owner",
    });

    assert.equal(approval.status, "REJECTED");
  });

  it("rejects APPROVED -> REJECTED -- a resolved Approval is terminal", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("approvals", { id: "approval-1", status: "APPROVED" });
    const { app } = makeApp(approvalDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionApprovalStatus({
          approvalId: "approval-1",
          from: "APPROVED",
          to: "REJECTED",
          merchantId: MERCHANT_ID,
          actorType: "HUMAN_MERCHANT",
        }),
      InvalidTransitionError,
    );
  });

  it("rejects a stale from-status with StaleTransitionError", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("approvals", { id: "approval-1", status: "APPROVED" });
    const { app } = makeApp(approvalDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionApprovalStatus({
          approvalId: "approval-1",
          from: "PENDING",
          to: "APPROVED",
          merchantId: MERCHANT_ID,
          actorType: "HUMAN_MERCHANT",
        }),
      StaleTransitionError,
    );
  });
});

describe("boundary integrity: the Approval application layer never mutates status directly", () => {
  it("the Supabase-backed ApprovalDbClient exposes only the four intended operations -- no update/patch operation exists to call", () => {
    const client = toApprovalDbClient({} as unknown as SupabaseClient);
    assert.deepEqual(Object.keys(client).sort(), [
      "getApprovalById",
      "getLatestApprovalByQuoteId",
      "getQuoteRef",
      "insertApproval",
    ]);
    assert.equal(Reflect.has(client, "update"), false);
  });

  it("createApproval() and read paths never touch lib/runtime's StatusDbClient at all", async () => {
    const statusDb = new FakeStatusDb();
    const db = new FakeApprovalDb();
    seedQuote(db);
    const { app } = makeApp(db, statusDb);

    await app.createApproval(VALID_INPUT);
    assert.equal(statusDb.calls.length, 0);

    await assert.rejects(() => app.getApprovalById("does-not-exist"));
    assert.equal(statusDb.calls.length, 0);
  });

  it("transitionApprovalStatus() touches only the table(s) an Approval transition legitimately owns", async () => {
    const statusDb = new FakeStatusDb({ allowedTables: ["approvals", "audit_events"] });
    statusDb.seed("approvals", { id: "approval-1", status: "PENDING" });
    const { app } = makeApp(approvalDbFromStatusDb(statusDb), statusDb);

    await app.transitionApprovalStatus({
      approvalId: "approval-1",
      from: "PENDING",
      to: "APPROVED",
      merchantId: MERCHANT_ID,
      actorType: "HUMAN_MERCHANT",
      approvedBy: "merchant-owner",
    });

    assert.equal(statusDb.getRow("approvals", "approval-1")?.status, "APPROVED");
  });
});

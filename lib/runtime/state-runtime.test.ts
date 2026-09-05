import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStateRuntime } from "./state-runtime.ts";
import type { AppEvent } from "./events.ts";
import { FakeStatusDb } from "../state-machine/test-support.ts";
import {
  InvalidTransitionError,
  OrderPaymentNotVerifiedError,
  StaleTransitionError,
} from "../state-machine/errors.ts";

const MERCHANT_ID = "merchant-1";

describe("createStateRuntime: creates a runtime whose only surface is dispatch()", () => {
  it("returns an object exposing exactly one method", () => {
    const runtime = createStateRuntime(new FakeStatusDb());
    assert.deepEqual(Object.keys(runtime), ["dispatch"]);
    assert.equal(typeof runtime.dispatch, "function");
  });
});

describe("dispatch: applies a valid event through lib/state-machine and returns the resulting state", () => {
  it("RFQ_TRANSITION: CREATED -> PROCESSING", async () => {
    const db = new FakeStatusDb();
    db.seed("rfqs", { id: "rfq-1", status: "CREATED" });
    const runtime = createStateRuntime(db);

    const result = await runtime.dispatch({
      type: "RFQ_TRANSITION",
      rfqId: "rfq-1",
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.deepEqual(result, { entity: "rfq", id: "rfq-1", status: "PROCESSING" });
    assert.equal(db.getRow("rfqs", "rfq-1")?.status, "PROCESSING");
    assert.equal(db.tableMap("audit_events").size, 1);
  });

  it("QUOTE_TRANSITION: DRAFT -> SENT", async () => {
    const db = new FakeStatusDb();
    db.seed("quotes", { id: "quote-1", status: "DRAFT" });
    const runtime = createStateRuntime(db);

    const result = await runtime.dispatch({
      type: "QUOTE_TRANSITION",
      quoteId: "quote-1",
      from: "DRAFT",
      to: "SENT",
      merchantId: MERCHANT_ID,
      actorType: "SELLER_AGENT",
    });

    assert.deepEqual(result, { entity: "quote", id: "quote-1", status: "SENT" });
    assert.equal(db.getRow("quotes", "quote-1")?.status, "SENT");
  });

  it("ORDER_TRANSITION: CREATED -> CANCELLED (no payment verification required)", async () => {
    const db = new FakeStatusDb();
    db.seed("orders", { id: "order-1", status: "CREATED" });
    const runtime = createStateRuntime(db);

    const result = await runtime.dispatch({
      type: "ORDER_TRANSITION",
      orderId: "order-1",
      from: "CREATED",
      to: "CANCELLED",
      merchantId: MERCHANT_ID,
      actorType: "BUYER",
    });

    assert.deepEqual(result, { entity: "order", id: "order-1", status: "CANCELLED" });
  });

  it("ORDER_TRANSITION: PAYMENT_PENDING -> PAID still requires a verified payment row, propagated unchanged", async () => {
    const db = new FakeStatusDb();
    db.seed("orders", { id: "order-1", status: "PAYMENT_PENDING" });
    const runtime = createStateRuntime(db);

    await assert.rejects(
      () =>
        runtime.dispatch({
          type: "ORDER_TRANSITION",
          orderId: "order-1",
          from: "PAYMENT_PENDING",
          to: "PAID",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      OrderPaymentNotVerifiedError,
    );
  });

  it("PAYMENT_TRANSITION: CREATED -> PENDING", async () => {
    const db = new FakeStatusDb();
    db.seed("payments", { id: "payment-1", status: "CREATED" });
    const runtime = createStateRuntime(db);

    const result = await runtime.dispatch({
      type: "PAYMENT_TRANSITION",
      paymentId: "payment-1",
      from: "CREATED",
      to: "PENDING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.deepEqual(result, { entity: "payment", id: "payment-1", status: "PENDING" });
  });

  it("PAYMENT_MARK_PAID: PENDING -> PAID, the only event that can reach PAID", async () => {
    const db = new FakeStatusDb();
    db.seed("payments", { id: "payment-1", status: "PENDING" });
    const runtime = createStateRuntime(db);

    const result = await runtime.dispatch({
      type: "PAYMENT_MARK_PAID",
      paymentId: "payment-1",
      from: "PENDING",
      merchantId: MERCHANT_ID,
      verification: { razorpayPaymentId: "pay_test123", verifiedVia: "RAZORPAY_WEBHOOK" },
    });

    assert.deepEqual(result, { entity: "payment", id: "payment-1", status: "PAID" });
    assert.equal(db.getRow("payments", "payment-1")?.status, "PAID");
  });

  it("APPROVAL_TRANSITION: PENDING -> APPROVED", async () => {
    const db = new FakeStatusDb();
    db.seed("approvals", { id: "approval-1", status: "PENDING" });
    const runtime = createStateRuntime(db);

    const result = await runtime.dispatch({
      type: "APPROVAL_TRANSITION",
      approvalId: "approval-1",
      from: "PENDING",
      to: "APPROVED",
      merchantId: MERCHANT_ID,
      actorType: "HUMAN_MERCHANT",
      approvedBy: "merchant-user-1",
    });

    assert.deepEqual(result, { entity: "approval", id: "approval-1", status: "APPROVED" });
    assert.equal(db.getRow("approvals", "approval-1")?.approved_by, "merchant-user-1");
  });

  it("AGENT_SESSION_TRANSITION: RUNNING -> COMPLETED", async () => {
    const db = new FakeStatusDb();
    db.seed("agent_sessions", { id: "session-1", status: "RUNNING", ended_at: null });
    const runtime = createStateRuntime(db);

    const result = await runtime.dispatch({
      type: "AGENT_SESSION_TRANSITION",
      sessionId: "session-1",
      from: "RUNNING",
      to: "COMPLETED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.deepEqual(result, { entity: "agentSession", id: "session-1", status: "COMPLETED" });
    assert.equal(typeof db.getRow("agent_sessions", "session-1")?.ended_at, "string");
  });
});

describe("dispatch: rejects invalid transitions exactly as lib/state-machine would", () => {
  it("rejects a disallowed edge with InvalidTransitionError", async () => {
    const db = new FakeStatusDb();
    db.seed("rfqs", { id: "rfq-1", status: "ACCEPTED" });
    const runtime = createStateRuntime(db);

    await assert.rejects(
      () =>
        runtime.dispatch({
          type: "RFQ_TRANSITION",
          rfqId: "rfq-1",
          from: "ACCEPTED",
          to: "QUOTED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      InvalidTransitionError,
    );
    // Rejected before any write: the row is untouched.
    assert.equal(db.getRow("rfqs", "rfq-1")?.status, "ACCEPTED");
  });

  it("rejects a stale/concurrent transition with StaleTransitionError", async () => {
    const db = new FakeStatusDb();
    db.seed("quotes", { id: "quote-1", status: "SENT" });
    const runtime = createStateRuntime(db);

    await assert.rejects(
      () =>
        runtime.dispatch({
          type: "QUOTE_TRANSITION",
          quoteId: "quote-1",
          from: "DRAFT", // stale belief; row is actually SENT
          to: "SENT",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });
});

describe("dispatch: does not allow direct state mutation -- it is the only path in", () => {
  it("touches only the table(s) the underlying transition function owns, never anything dispatch() was not asked to change", async () => {
    const db = new FakeStatusDb({ allowedTables: ["rfqs", "audit_events"] });
    db.seed("rfqs", { id: "rfq-1", status: "CREATED" });
    const runtime = createStateRuntime(db);

    // Would throw synchronously (surfacing as a rejection) if dispatch(), or
    // anything it calls, reached into a table beyond what an RFQ transition
    // legitimately owns -- proving there is no side-channel mutation here.
    await runtime.dispatch({
      type: "RFQ_TRANSITION",
      rfqId: "rfq-1",
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(db.getRow("rfqs", "rfq-1")?.status, "PROCESSING");
  });

  it("StateRuntime has no property other than dispatch through which a consumer could reach the client", () => {
    const db = new FakeStatusDb();
    const runtime = createStateRuntime(db);
    assert.equal(Reflect.has(runtime, "client"), false);
    assert.equal(Reflect.has(runtime, "db"), false);
  });
});

describe("dispatch: preserves state across sequential calls (the runtime lifecycle)", () => {
  it("a sequence of dispatches against the same runtime/db reflects each prior transition", async () => {
    const db = new FakeStatusDb();
    db.seed("rfqs", { id: "rfq-1", status: "CREATED" });
    const runtime = createStateRuntime(db);

    const events: AppEvent[] = [
      {
        type: "RFQ_TRANSITION",
        rfqId: "rfq-1",
        from: "CREATED",
        to: "PROCESSING",
        merchantId: MERCHANT_ID,
        actorType: "SYSTEM",
      },
      {
        type: "RFQ_TRANSITION",
        rfqId: "rfq-1",
        from: "PROCESSING",
        to: "QUOTED",
        merchantId: MERCHANT_ID,
        actorType: "SELLER_AGENT",
      },
      {
        type: "RFQ_TRANSITION",
        rfqId: "rfq-1",
        from: "QUOTED",
        to: "NEGOTIATING",
        merchantId: MERCHANT_ID,
        actorType: "BUYER",
      },
    ];

    for (const event of events) {
      await runtime.dispatch(event);
    }

    assert.equal(db.getRow("rfqs", "rfq-1")?.status, "NEGOTIATING");
    assert.equal(db.tableMap("audit_events").size, 3);
  });
});

describe("dispatch: reset/reinitialization -- a fresh runtime is fully independent", () => {
  it("a second createStateRuntime() call over a different db does not share state with the first", async () => {
    const dbA = new FakeStatusDb();
    dbA.seed("rfqs", { id: "rfq-1", status: "CREATED" });
    const runtimeA = createStateRuntime(dbA);

    const dbB = new FakeStatusDb();
    dbB.seed("rfqs", { id: "rfq-1", status: "CREATED" });
    const runtimeB = createStateRuntime(dbB);

    await runtimeA.dispatch({
      type: "RFQ_TRANSITION",
      rfqId: "rfq-1",
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    // runtimeB, backed by its own db, is untouched by runtimeA's dispatch.
    assert.equal(dbA.getRow("rfqs", "rfq-1")?.status, "PROCESSING");
    assert.equal(dbB.getRow("rfqs", "rfq-1")?.status, "CREATED");

    await runtimeB.dispatch({
      type: "RFQ_TRANSITION",
      rfqId: "rfq-1",
      from: "CREATED",
      to: "CANCELLED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(dbA.getRow("rfqs", "rfq-1")?.status, "PROCESSING");
    assert.equal(dbB.getRow("rfqs", "rfq-1")?.status, "CANCELLED");
  });
});

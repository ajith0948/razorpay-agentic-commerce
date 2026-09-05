import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Order, OrderStatus, Rfq, RfqStatus } from "./api-client.ts";
import { derivePurchaseProgress, type PurchaseStage, type PurchaseStageKey } from "./purchase-progress.ts";

function makeRfq(status: RfqStatus): Rfq {
  return {
    id: "rfq-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    rawRequest: "5000 corrugated boxes to Chennai",
    structuredRequirements: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
  };
}

function makeOrder(status: OrderStatus): Order {
  return {
    id: "order-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    rfqId: "rfq-1",
    quoteId: "quote-1",
    totalAmount: 50000,
    currency: "INR",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function stage(stages: PurchaseStage[], key: PurchaseStageKey): PurchaseStage {
  const found = stages.find((s) => s.key === key);
  assert.ok(found, `expected a stage with key ${key}`);
  return found;
}

describe("derivePurchaseProgress: shape", () => {
  it("always returns exactly the five stages, in Request/Quote/Approval/Order/Payment order", () => {
    const stages = derivePurchaseProgress({ rfq: null, order: null, awaitingPaymentApproval: false });
    assert.deepEqual(
      stages.map((s) => s.key),
      ["request", "quote", "approval", "order", "payment"],
    );
    assert.deepEqual(
      stages.map((s) => s.label),
      ["Request", "Quote", "Approval", "Order", "Payment"],
    );
  });
});

describe("derivePurchaseProgress: empty state (no rfq yet)", () => {
  it("shows every stage as upcoming with an inviting, non-technical detail", () => {
    const stages = derivePurchaseProgress({ rfq: null, order: null, awaitingPaymentApproval: false });
    for (const s of stages) {
      assert.equal(s.state, "upcoming");
    }
    assert.equal(stage(stages, "request").detail, "Tell the AI what you need to get started.");
  });
});

describe("derivePurchaseProgress: Request stage (from rfq.status)", () => {
  it("CREATED -> active, Request received", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("CREATED"), order: null, awaitingPaymentApproval: false });
    assert.deepEqual(stage(stages, "request"), { key: "request", label: "Request", state: "active", detail: "Request received" });
  });

  it("PROCESSING -> active, Preparing your request (exact spec wording)", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("PROCESSING"), order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "request").state, "active");
    assert.equal(stage(stages, "request").detail, "Preparing your request");
  });

  it("QUOTED/NEGOTIATING/ACCEPTED/REJECTED all mean the request itself is understood", () => {
    for (const status of ["QUOTED", "NEGOTIATING", "ACCEPTED", "REJECTED"] as const) {
      const stages = derivePurchaseProgress({ rfq: makeRfq(status), order: null, awaitingPaymentApproval: false });
      assert.equal(stage(stages, "request").state, "done", `status ${status}`);
      assert.equal(stage(stages, "request").detail, "Request understood", `status ${status}`);
    }
  });

  it("EXPIRED/CANCELLED/FAILED are all blocked, each with its own honest detail", () => {
    const expired = derivePurchaseProgress({ rfq: makeRfq("EXPIRED"), order: null, awaitingPaymentApproval: false });
    assert.deepEqual(stage(expired, "request"), { key: "request", label: "Request", state: "blocked", detail: "Request expired" });

    const cancelled = derivePurchaseProgress({ rfq: makeRfq("CANCELLED"), order: null, awaitingPaymentApproval: false });
    assert.deepEqual(stage(cancelled, "request"), {
      key: "request",
      label: "Request",
      state: "blocked",
      detail: "Request was cancelled",
    });

    const failed = derivePurchaseProgress({ rfq: makeRfq("FAILED"), order: null, awaitingPaymentApproval: false });
    assert.deepEqual(stage(failed, "request"), {
      key: "request",
      label: "Request",
      state: "blocked",
      detail: "We couldn't process this request",
    });
  });
});

describe("derivePurchaseProgress: Quote stage (from rfq.status, or from order presence)", () => {
  it("CREATED/PROCESSING -> upcoming, not ready yet", () => {
    for (const status of ["CREATED", "PROCESSING"] as const) {
      const stages = derivePurchaseProgress({ rfq: makeRfq(status), order: null, awaitingPaymentApproval: false });
      assert.equal(stage(stages, "quote").state, "upcoming", `status ${status}`);
    }
  });

  it("QUOTED -> active, Quote being prepared (exact spec wording)", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("QUOTED"), order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "quote").state, "active");
    assert.equal(stage(stages, "quote").detail, "Quote being prepared");
  });

  it("NEGOTIATING -> active, Negotiating the quote", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("NEGOTIATING"), order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "quote").state, "active");
    assert.equal(stage(stages, "quote").detail, "Negotiating the quote");
  });

  it("ACCEPTED -> done, Quote accepted (exact spec wording)", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "quote").state, "done");
    assert.equal(stage(stages, "quote").detail, "Quote accepted");
  });

  it("REJECTED -> blocked, Quote was rejected", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("REJECTED"), order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "quote").state, "blocked");
    assert.equal(stage(stages, "quote").detail, "Quote was rejected");
  });

  it("EXPIRED/CANCELLED/FAILED -> blocked, request did not proceed", () => {
    for (const status of ["EXPIRED", "CANCELLED", "FAILED"] as const) {
      const stages = derivePurchaseProgress({ rfq: makeRfq(status), order: null, awaitingPaymentApproval: false });
      assert.equal(stage(stages, "quote").state, "blocked", `status ${status}`);
      assert.equal(stage(stages, "quote").detail, "No quote -- request did not proceed", `status ${status}`);
    }
  });

  it("an existing order always means the quote was accepted, even if rfq.status disagrees or rfq is unknown", () => {
    const withoutRfq = derivePurchaseProgress({ rfq: null, order: makeOrder("CREATED"), awaitingPaymentApproval: false });
    assert.equal(stage(withoutRfq, "quote").state, "done");
    assert.equal(stage(withoutRfq, "quote").detail, "Quote accepted");
  });
});

describe("derivePurchaseProgress: Approval stage", () => {
  it("is upcoming ('not needed yet') with no order and no pending approval", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "approval").state, "upcoming");
    assert.equal(stage(stages, "approval").detail, "Not needed yet");
  });

  it("is active with the exact spec wording while the agent is stopped on create_payment", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder("CREATED"), awaitingPaymentApproval: true });
    assert.equal(stage(stages, "approval").state, "active");
    assert.equal(stage(stages, "approval").detail, "Waiting for manager approval");
  });

  it("awaitingPaymentApproval wins over an order that already moved past CREATED", () => {
    // Defensive: in practice these shouldn't co-occur, but the pending flag
    // is the more direct signal and must never be shadowed by an inference.
    const stages = derivePurchaseProgress({
      rfq: makeRfq("ACCEPTED"),
      order: makeOrder("PAYMENT_PENDING"),
      awaitingPaymentApproval: true,
    });
    assert.equal(stage(stages, "approval").state, "active");
    assert.equal(stage(stages, "approval").detail, "Waiting for manager approval");
  });

  it("is done ('Cleared') once the order has moved past CREATED with no pending approval -- create_payment could only have succeeded if the gate was already satisfied", () => {
    for (const status of ["PAYMENT_PENDING", "PAID", "CONFIRMED", "PAYMENT_FAILED"] as const) {
      const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder(status), awaitingPaymentApproval: false });
      assert.equal(stage(stages, "approval").state, "done", `order status ${status}`);
      assert.equal(stage(stages, "approval").detail, "Cleared", `order status ${status}`);
    }
  });

  it("stays upcoming while the order exists but is still just CREATED (no payment attempt yet)", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder("CREATED"), awaitingPaymentApproval: false });
    assert.equal(stage(stages, "approval").state, "upcoming");
    assert.equal(stage(stages, "approval").detail, "Not needed yet");
  });
});

describe("derivePurchaseProgress: Order stage (from order.status)", () => {
  it("no order -> upcoming, not created yet", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "order").state, "upcoming");
    assert.equal(stage(stages, "order").detail, "Not created yet");
  });

  it("CREATED/PAYMENT_PENDING/PAID/CONFIRMED all mean the order exists (exact spec wording 'Order created')", () => {
    for (const status of ["CREATED", "PAYMENT_PENDING", "PAID", "CONFIRMED"] as const) {
      const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder(status), awaitingPaymentApproval: false });
      assert.equal(stage(stages, "order").state, "done", `status ${status}`);
      assert.equal(stage(stages, "order").detail, "Order created", `status ${status}`);
    }
  });

  it("PAYMENT_FAILED -> blocked, payment failed for this order", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder("PAYMENT_FAILED"), awaitingPaymentApproval: false });
    assert.equal(stage(stages, "order").state, "blocked");
    assert.equal(stage(stages, "order").detail, "Payment failed for this order");
  });

  it("CANCELLED -> blocked, order was cancelled", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder("CANCELLED"), awaitingPaymentApproval: false });
    assert.equal(stage(stages, "order").state, "blocked");
    assert.equal(stage(stages, "order").detail, "Order was cancelled");
  });
});

describe("derivePurchaseProgress: Payment stage (from order.status)", () => {
  it("no order -> upcoming, not completed yet", () => {
    const stages = derivePurchaseProgress({ rfq: null, order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "payment").state, "upcoming");
    assert.equal(stage(stages, "payment").detail, "Not completed yet");
  });

  it("order CREATED -> upcoming, not completed yet", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder("CREATED"), awaitingPaymentApproval: false });
    assert.equal(stage(stages, "payment").state, "upcoming");
    assert.equal(stage(stages, "payment").detail, "Not completed yet");
  });

  it("order PAYMENT_PENDING -> active, exact spec wording 'Payment not completed yet'", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder("PAYMENT_PENDING"), awaitingPaymentApproval: false });
    assert.equal(stage(stages, "payment").state, "active");
    assert.equal(stage(stages, "payment").detail, "Payment not completed yet");
  });

  it("order PAID/CONFIRMED -> done, exact spec wording 'Payment verified'", () => {
    for (const status of ["PAID", "CONFIRMED"] as const) {
      const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder(status), awaitingPaymentApproval: false });
      assert.equal(stage(stages, "payment").state, "done", `status ${status}`);
      assert.equal(stage(stages, "payment").detail, "Payment verified", `status ${status}`);
    }
  });

  it("order PAYMENT_FAILED -> blocked, payment failed", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder("PAYMENT_FAILED"), awaitingPaymentApproval: false });
    assert.equal(stage(stages, "payment").state, "blocked");
    assert.equal(stage(stages, "payment").detail, "Payment failed");
  });

  it("order CANCELLED -> blocked, order was cancelled", () => {
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: makeOrder("CANCELLED"), awaitingPaymentApproval: false });
    assert.equal(stage(stages, "payment").state, "blocked");
    assert.equal(stage(stages, "payment").detail, "Order was cancelled");
  });
});

describe("derivePurchaseProgress: post-quote-acceptance regression (RFQ ACCEPTED, no order yet)", () => {
  it("shows Request=done, Quote=done, Approval=upcoming, Order=upcoming, Payment=upcoming when RFQ is ACCEPTED and no order exists", () => {
    // This was the failing scenario: RFQ stayed QUOTED due to missing QUOTED->ACCEPTED
    // edge in the state machine, so Purchase Progress showed "Quote being prepared" instead.
    const stages = derivePurchaseProgress({ rfq: makeRfq("ACCEPTED"), order: null, awaitingPaymentApproval: false });

    assert.deepEqual(stage(stages, "request"),  { key: "request",  label: "Request",  state: "done",     detail: "Request understood" });
    assert.deepEqual(stage(stages, "quote"),    { key: "quote",    label: "Quote",    state: "done",     detail: "Quote accepted" });
    assert.deepEqual(stage(stages, "approval"), { key: "approval", label: "Approval", state: "upcoming", detail: "Not needed yet" });
    assert.deepEqual(stage(stages, "order"),    { key: "order",    label: "Order",    state: "upcoming", detail: "Not created yet" });
    assert.deepEqual(stage(stages, "payment"),  { key: "payment",  label: "Payment",  state: "upcoming", detail: "Not completed yet" });
  });

  it("the QUOTED status that was incorrectly left behind shows 'Quote being prepared' -- confirming the state-machine fix is necessary", () => {
    // Ensures that if the RFQ were still QUOTED (the pre-fix state), Purchase Progress
    // correctly shows "Quote being prepared" -- which proves the state machine fix
    // is what makes the difference, not a UI workaround.
    const stages = derivePurchaseProgress({ rfq: makeRfq("QUOTED"), order: null, awaitingPaymentApproval: false });
    assert.equal(stage(stages, "quote").state, "active");
    assert.equal(stage(stages, "quote").detail, "Quote being prepared");
  });
});


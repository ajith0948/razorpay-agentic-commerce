import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleCreatePayment } from "./route.ts";
import type { PaymentApplication } from "../../../lib/payment/index.ts";
import {
  PaymentOrderNotFoundError,
  PaymentOrderStateError,
  PaymentPersistenceError,
  PaymentValidationError,
} from "../../../lib/payment/index.ts";
import type { CreatePaymentInput, Payment } from "../../../lib/payment/types.ts";

const ORDER_ID = "22222222-2222-4222-a222-222222222222";
const QUOTE_ID = "quote-1";

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "payment-1",
    orderId: ORDER_ID,
    quoteId: QUOTE_ID,
    razorpayOrderId: null,
    razorpayPaymentLinkId: null,
    amount: 114000,
    currency: "INR",
    status: "CREATED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Fake PaymentApplication -- this route only ever calls createPayment().
 * getPaymentById()/transitionPaymentStatus()/markPaymentPaid() all throw if
 * reached, so a test would fail loudly (not silently pass) if the route
 * ever started calling a method it has no business calling -- in
 * particular, this proves POST /api/payments never dispatches a lifecycle
 * transition, and NEVER reaches PAID, merely because a Payment was created.
 */
class FakePaymentApplication implements PaymentApplication {
  createPaymentCalls: CreatePaymentInput[] = [];
  createPaymentImpl: (input: CreatePaymentInput) => Promise<Payment> = async (input) =>
    makePayment({
      orderId: input.orderId,
      razorpayOrderId: input.razorpayOrderId ?? null,
      razorpayPaymentLinkId: input.razorpayPaymentLinkId ?? null,
    });

  async createPayment(input: CreatePaymentInput): Promise<Payment> {
    this.createPaymentCalls.push(input);
    return this.createPaymentImpl(input);
  }

  async getPaymentById(): Promise<Payment> {
    throw new Error(
      "FakePaymentApplication: getPaymentById() should not be called by POST /api/payments",
    );
  }

  async transitionPaymentStatus(): Promise<Payment> {
    throw new Error(
      "FakePaymentApplication: transitionPaymentStatus() should not be called by POST /api/payments " +
        "-- creating a Payment must never itself dispatch a lifecycle transition.",
    );
  }

  async markPaymentPaid(): Promise<Payment> {
    throw new Error(
      "FakePaymentApplication: markPaymentPaid() should not be called by POST /api/payments " +
        "-- creating a Payment must NEVER itself mark that Payment PAID.",
    );
  }
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(rawBody: string): Request {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

describe("POST /api/payments: success", () => {
  it("returns 201 with the created Payment, status CREATED -- never PAID", async () => {
    const app = new FakePaymentApplication();
    const res = await handleCreatePayment(app, jsonRequest({ orderId: ORDER_ID }));

    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.payment.orderId, ORDER_ID);
    assert.equal(payload.payment.status, "CREATED");
    assert.notEqual(payload.payment.status, "PAID");
  });

  it("calls createPayment() exactly once, with exactly {orderId}", async () => {
    const app = new FakePaymentApplication();
    await handleCreatePayment(app, jsonRequest({ orderId: ORDER_ID }));

    assert.deepEqual(app.createPaymentCalls, [{ orderId: ORDER_ID }]);
  });

  it("passes optional razorpayOrderId/razorpayPaymentLinkId straight through, and still never reaches PAID", async () => {
    const app = new FakePaymentApplication();
    const res = await handleCreatePayment(
      app,
      jsonRequest({
        orderId: ORDER_ID,
        razorpayOrderId: "razorpay_order_abc",
        razorpayPaymentLinkId: "razorpay_plink_abc",
      }),
    );

    assert.deepEqual(app.createPaymentCalls, [
      {
        orderId: ORDER_ID,
        razorpayOrderId: "razorpay_order_abc",
        razorpayPaymentLinkId: "razorpay_plink_abc",
      },
    ]);

    const payload = await res.json();
    assert.equal(payload.payment.status, "CREATED");
  });
});

describe("POST /api/payments: policy/order-state rejection (422)", () => {
  it("maps PaymentOrderStateError to 422 ORDER_NOT_ELIGIBLE_FOR_PAYMENT (existing behavior -- Order not payment-eligible)", async () => {
    const app = new FakePaymentApplication();
    app.createPaymentImpl = async () => {
      throw new PaymentOrderStateError(ORDER_ID, "PAID");
    };

    const res = await handleCreatePayment(app, jsonRequest({ orderId: ORDER_ID }));

    assert.equal(res.status, 422);
    const payload = await res.json();
    assert.equal(payload.error.code, "ORDER_NOT_ELIGIBLE_FOR_PAYMENT");
    assert.equal(payload.error.orderStatus, "PAID");
  });
});

describe("POST /api/payments: invalid order (404)", () => {
  it("maps PaymentOrderNotFoundError to 404 ORDER_NOT_FOUND", async () => {
    const app = new FakePaymentApplication();
    app.createPaymentImpl = async () => {
      throw new PaymentOrderNotFoundError(ORDER_ID);
    };

    const res = await handleCreatePayment(app, jsonRequest({ orderId: ORDER_ID }));

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "ORDER_NOT_FOUND");
  });
});

describe("POST /api/payments: request validation (400)", () => {
  it("returns 400 INVALID_REQUEST_BODY for malformed JSON", async () => {
    const app = new FakePaymentApplication();
    const res = await handleCreatePayment(app, rawRequest("{not json"));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createPaymentCalls.length, 0);
  });

  it("returns 400 INVALID_REQUEST_BODY when orderId is missing", async () => {
    const app = new FakePaymentApplication();
    const res = await handleCreatePayment(app, jsonRequest({}));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createPaymentCalls.length, 0);
  });

  it("maps PaymentValidationError to 400 VALIDATION_ERROR", async () => {
    const app = new FakePaymentApplication();
    app.createPaymentImpl = async () => {
      throw new PaymentValidationError("orderId", "is required");
    };

    const res = await handleCreatePayment(app, jsonRequest({ orderId: ORDER_ID }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "VALIDATION_ERROR");
  });
});

describe("POST /api/payments: persistence failure (500, no internal leak)", () => {
  it("maps a PaymentPersistenceError to 500 without leaking its message", async () => {
    const app = new FakePaymentApplication();
    const secret = "duplicate key value violates unique constraint";
    app.createPaymentImpl = async () => {
      throw new PaymentPersistenceError("insert", secret);
    };

    const res = await handleCreatePayment(app, jsonRequest({ orderId: ORDER_ID }));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });
});

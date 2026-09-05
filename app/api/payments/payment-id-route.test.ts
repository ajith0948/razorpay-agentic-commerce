/**
 * Tests for GET /api/payments/:id (app/api/payments/[id]/route.ts). This
 * file deliberately lives here, one level up from the route it tests,
 * rather than alongside it -- same bracket-glob reasoning as
 * app/api/quotes/quote-id-route.test.ts's own header comment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleGetPayment } from "./[id]/route.ts";
import type { PaymentApplication } from "../../../lib/payment/index.ts";
import { PaymentNotFoundError, PaymentPersistenceError } from "../../../lib/payment/index.ts";
import type { Payment } from "../../../lib/payment/types.ts";

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "payment-1",
    orderId: "order-1",
    quoteId: "quote-1",
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
 * Fake PaymentApplication -- this route only ever calls getPaymentById().
 * createPayment()/transitionPaymentStatus()/markPaymentPaid() all throw if
 * reached, so a test would fail loudly if GET ever started performing a
 * write.
 */
class FakePaymentApplication implements PaymentApplication {
  getPaymentByIdCalls: string[] = [];
  getPaymentByIdImpl: (paymentId: string) => Promise<Payment> = async (paymentId) =>
    makePayment({ id: paymentId });

  async createPayment(): Promise<Payment> {
    throw new Error(
      "FakePaymentApplication: createPayment() should not be called by GET /api/payments/:id",
    );
  }

  async getPaymentById(paymentId: string): Promise<Payment> {
    this.getPaymentByIdCalls.push(paymentId);
    return this.getPaymentByIdImpl(paymentId);
  }

  async transitionPaymentStatus(): Promise<Payment> {
    throw new Error(
      "FakePaymentApplication: transitionPaymentStatus() should not be called by GET /api/payments/:id",
    );
  }

  async markPaymentPaid(): Promise<Payment> {
    throw new Error(
      "FakePaymentApplication: markPaymentPaid() should not be called by GET /api/payments/:id",
    );
  }
}

describe("GET /api/payments/:id: success", () => {
  it("returns 200 with the Payment for a valid id", async () => {
    const app = new FakePaymentApplication();
    const res = await handleGetPayment(app, "payment-42");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.payment.id, "payment-42");
  });

  it("delegates to getPaymentById() with exactly the given id, and calls it exactly once", async () => {
    const app = new FakePaymentApplication();
    await handleGetPayment(app, "payment-42");

    assert.deepEqual(app.getPaymentByIdCalls, ["payment-42"]);
  });
});

describe("GET /api/payments/:id: missing payment (404)", () => {
  it("maps PaymentNotFoundError to 404 PAYMENT_NOT_FOUND", async () => {
    const app = new FakePaymentApplication();
    app.getPaymentByIdImpl = async () => {
      throw new PaymentNotFoundError("payment-42");
    };

    const res = await handleGetPayment(app, "payment-42");

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "PAYMENT_NOT_FOUND");
  });
});

describe("GET /api/payments/:id: persistence failure (500, no internal leak)", () => {
  it("maps a PaymentPersistenceError to 500 without leaking its message", async () => {
    const app = new FakePaymentApplication();
    const secret = "duplicate key value violates unique constraint";
    app.getPaymentByIdImpl = async () => {
      throw new PaymentPersistenceError("select", secret);
    };

    const res = await handleGetPayment(app, "payment-42");

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });
});

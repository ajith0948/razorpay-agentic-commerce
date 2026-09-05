/**
 * Tests for GET /api/orders/:id (app/api/orders/[id]/route.ts). This file
 * deliberately lives here, one level up from the route it tests, rather than
 * alongside it -- same bracket-glob reasoning as
 * app/api/quotes/quote-id-route.test.ts's own header comment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleGetOrder } from "./[id]/route.ts";
import type { OrderApplication } from "../../../lib/order/index.ts";
import { OrderNotFoundError, OrderPersistenceError } from "../../../lib/order/index.ts";
import type { Order } from "../../../lib/order/types.ts";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    rfqId: "rfq-1",
    quoteId: "quote-1",
    totalAmount: 114000,
    currency: "INR",
    status: "CREATED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Fake OrderApplication -- this route only ever calls getOrderById().
 * createOrder()/transitionOrderStatus() throw if reached, so a test would
 * fail loudly if GET ever started performing a write.
 */
class FakeOrderApplication implements OrderApplication {
  getOrderByIdCalls: string[] = [];
  getOrderByIdImpl: (orderId: string) => Promise<Order> = async (orderId) =>
    makeOrder({ id: orderId });

  async createOrder(): Promise<Order> {
    throw new Error("FakeOrderApplication: createOrder() should not be called by GET /api/orders/:id");
  }

  async getOrderById(orderId: string): Promise<Order> {
    this.getOrderByIdCalls.push(orderId);
    return this.getOrderByIdImpl(orderId);
  }

  async transitionOrderStatus(): Promise<Order> {
    throw new Error(
      "FakeOrderApplication: transitionOrderStatus() should not be called by GET /api/orders/:id",
    );
  }
}

describe("GET /api/orders/:id: success", () => {
  it("returns 200 with the Order for a valid id", async () => {
    const app = new FakeOrderApplication();
    const res = await handleGetOrder(app, "order-42");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.order.id, "order-42");
  });

  it("delegates to getOrderById() with exactly the given id, and calls it exactly once", async () => {
    const app = new FakeOrderApplication();
    await handleGetOrder(app, "order-42");

    assert.deepEqual(app.getOrderByIdCalls, ["order-42"]);
  });
});

describe("GET /api/orders/:id: missing order (404)", () => {
  it("maps OrderNotFoundError to 404 ORDER_NOT_FOUND", async () => {
    const app = new FakeOrderApplication();
    app.getOrderByIdImpl = async () => {
      throw new OrderNotFoundError("order-42");
    };

    const res = await handleGetOrder(app, "order-42");

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "ORDER_NOT_FOUND");
  });
});

describe("GET /api/orders/:id: persistence failure (500, no internal leak)", () => {
  it("maps an OrderPersistenceError to 500 without leaking its message", async () => {
    const app = new FakeOrderApplication();
    const secret = "duplicate key value violates unique constraint";
    app.getOrderByIdImpl = async () => {
      throw new OrderPersistenceError("select", secret);
    };

    const res = await handleGetOrder(app, "order-42");

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });
});

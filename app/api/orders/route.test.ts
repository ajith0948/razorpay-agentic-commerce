import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleCreateOrder } from "./route.ts";
import type { OrderApplication } from "../../../lib/order/index.ts";
import {
  OrderAlreadyExistsError,
  OrderPersistenceError,
  OrderQuoteNotFoundError,
  OrderQuoteStateError,
  OrderValidationError,
} from "../../../lib/order/index.ts";
import type { CreateOrderInput, Order } from "../../../lib/order/types.ts";

const QUOTE_ID = "11111111-1111-4111-a111-111111111111";
const MERCHANT_ID = "merchant-1";
const BUYER_ID = "buyer-1";
const RFQ_ID = "rfq-1";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    merchantId: MERCHANT_ID,
    buyerId: BUYER_ID,
    rfqId: RFQ_ID,
    quoteId: QUOTE_ID,
    totalAmount: 114000,
    currency: "INR",
    status: "CREATED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Fake OrderApplication -- this route only ever calls createOrder().
 * getOrderById()/transitionOrderStatus() throw if reached, so a test would
 * fail loudly (not silently pass) if the route ever started calling a
 * method it has no business calling -- in particular, this proves POST
 * /api/orders never dispatches a lifecycle transition merely because an
 * Order was created.
 */
class FakeOrderApplication implements OrderApplication {
  createOrderCalls: CreateOrderInput[] = [];
  createOrderImpl: (input: CreateOrderInput) => Promise<Order> = async (input) =>
    makeOrder({ quoteId: input.quoteId });

  async createOrder(input: CreateOrderInput): Promise<Order> {
    this.createOrderCalls.push(input);
    return this.createOrderImpl(input);
  }

  async getOrderById(): Promise<Order> {
    throw new Error("FakeOrderApplication: getOrderById() should not be called by POST /api/orders");
  }

  async transitionOrderStatus(): Promise<Order> {
    throw new Error(
      "FakeOrderApplication: transitionOrderStatus() should not be called by POST /api/orders " +
        "-- creating an Order must never itself dispatch a lifecycle transition.",
    );
  }
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(rawBody: string): Request {
  return new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

describe("POST /api/orders: success", () => {
  it("returns 201 with the created Order, from an ACCEPTED Quote", async () => {
    const app = new FakeOrderApplication();
    const res = await handleCreateOrder(app, jsonRequest({ quoteId: QUOTE_ID }));

    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.order.quoteId, QUOTE_ID);
    assert.equal(payload.order.status, "CREATED");
  });

  it("calls createOrder() exactly once, with exactly {quoteId}", async () => {
    const app = new FakeOrderApplication();
    await handleCreateOrder(app, jsonRequest({ quoteId: QUOTE_ID }));

    assert.deepEqual(app.createOrderCalls, [{ quoteId: QUOTE_ID }]);
  });
});

describe("POST /api/orders: rejection when Quote is not ACCEPTED (422)", () => {
  it("maps OrderQuoteStateError to 422 QUOTE_NOT_ACCEPTED", async () => {
    const app = new FakeOrderApplication();
    app.createOrderImpl = async () => {
      throw new OrderQuoteStateError(QUOTE_ID, "NEGOTIATING");
    };

    const res = await handleCreateOrder(app, jsonRequest({ quoteId: QUOTE_ID }));

    assert.equal(res.status, 422);
    const payload = await res.json();
    assert.equal(payload.error.code, "QUOTE_NOT_ACCEPTED");
    assert.equal(payload.error.quoteStatus, "NEGOTIATING");
  });
});

describe("POST /api/orders: duplicate-order behavior (409)", () => {
  it("maps OrderAlreadyExistsError to 409 ORDER_ALREADY_EXISTS", async () => {
    const app = new FakeOrderApplication();
    app.createOrderImpl = async () => {
      throw new OrderAlreadyExistsError(QUOTE_ID, "order-existing");
    };

    const res = await handleCreateOrder(app, jsonRequest({ quoteId: QUOTE_ID }));

    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.equal(payload.error.code, "ORDER_ALREADY_EXISTS");
    assert.equal(payload.error.existingOrderId, "order-existing");
  });
});

describe("POST /api/orders: missing quote (404)", () => {
  it("maps OrderQuoteNotFoundError to 404 QUOTE_NOT_FOUND", async () => {
    const app = new FakeOrderApplication();
    app.createOrderImpl = async () => {
      throw new OrderQuoteNotFoundError(QUOTE_ID);
    };

    const res = await handleCreateOrder(app, jsonRequest({ quoteId: QUOTE_ID }));

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "QUOTE_NOT_FOUND");
  });
});

describe("POST /api/orders: request validation (400)", () => {
  it("returns 400 INVALID_REQUEST_BODY for malformed JSON", async () => {
    const app = new FakeOrderApplication();
    const res = await handleCreateOrder(app, rawRequest("{not json"));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createOrderCalls.length, 0);
  });

  it("returns 400 INVALID_REQUEST_BODY when quoteId is missing", async () => {
    const app = new FakeOrderApplication();
    const res = await handleCreateOrder(app, jsonRequest({}));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createOrderCalls.length, 0);
  });

  it("maps OrderValidationError to 400 VALIDATION_ERROR", async () => {
    const app = new FakeOrderApplication();
    app.createOrderImpl = async () => {
      throw new OrderValidationError("quoteId", "is required");
    };

    const res = await handleCreateOrder(app, jsonRequest({ quoteId: QUOTE_ID }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "VALIDATION_ERROR");
  });
});

describe("POST /api/orders: persistence failure (500, no internal leak)", () => {
  it("maps an OrderPersistenceError to 500 without leaking its message", async () => {
    const app = new FakeOrderApplication();
    const secret = "duplicate key value violates unique constraint";
    app.createOrderImpl = async () => {
      throw new OrderPersistenceError("insert", secret);
    };

    const res = await handleCreateOrder(app, jsonRequest({ quoteId: QUOTE_ID }));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createOrderApplication } from "./application.ts";
import type { NewOrderRow, OrderDbClient, OrderRow, QuoteRefRow } from "./db.ts";
import { toOrderDbClient } from "./supabase-order-db.ts";
import {
  OrderAlreadyExistsError,
  OrderNotFoundError,
  OrderPersistenceError,
  OrderQuoteNotFoundError,
  OrderQuoteStateError,
  OrderValidationError,
} from "./errors.ts";
import type { PostgrestResult } from "../state-machine/index.ts";
import { createStateRuntime } from "../runtime/index.ts";
import { FakeStatusDb } from "../state-machine/test-support.ts";
import {
  InvalidTransitionError,
  OrderPaymentNotVerifiedError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "../state-machine/errors.ts";

const MERCHANT_ID = "merchant-1";
const BUYER_ID = "buyer-1";
const RFQ_ID = "rfq-1";
const QUOTE_ID = "quote-1";

/**
 * Self-contained in-memory fake of OrderDbClient -- same spirit as
 * lib/quote/application.test.ts's FakeQuoteDb, extended with the
 * duplicate-Order-by-quote lookup this layer's createOrder() also needs.
 * Used for creation/retrieval tests, which never touch lib/runtime.
 */
class FakeOrderDb implements OrderDbClient {
  private readonly orders = new Map<string, OrderRow>();
  private readonly quotes = new Map<string, QuoteRefRow>();
  private nextId = 1;
  insertError: { message: string } | null = null;
  selectError: { message: string } | null = null;
  quoteSelectError: { message: string } | null = null;
  existingSelectError: { message: string } | null = null;

  seedOrder(row: OrderRow): void {
    this.orders.set(row.id, row);
  }

  seedQuote(row: QuoteRefRow): void {
    this.quotes.set(row.id, row);
  }

  insertOrder(row: NewOrderRow): PromiseLike<PostgrestResult<OrderRow>> {
    if (this.insertError) {
      return Promise.resolve({ data: null, error: this.insertError });
    }
    const now = new Date().toISOString();
    const stored: OrderRow = {
      id: `order-${this.nextId++}`,
      merchant_id: row.merchant_id,
      buyer_id: row.buyer_id,
      rfq_id: row.rfq_id,
      quote_id: row.quote_id,
      total_amount: row.total_amount,
      currency: row.currency,
      status: "CREATED",
      created_at: now,
      updated_at: now,
    };
    this.orders.set(stored.id, stored);
    return Promise.resolve({ data: stored, error: null });
  }

  getOrderById(id: string): PromiseLike<PostgrestResult<OrderRow>> {
    if (this.selectError) {
      return Promise.resolve({ data: null, error: this.selectError });
    }
    return Promise.resolve({ data: this.orders.get(id) ?? null, error: null });
  }

  getQuoteRef(quoteId: string): PromiseLike<PostgrestResult<QuoteRefRow>> {
    if (this.quoteSelectError) {
      return Promise.resolve({ data: null, error: this.quoteSelectError });
    }
    return Promise.resolve({ data: this.quotes.get(quoteId) ?? null, error: null });
  }

  getOrderByQuoteId(quoteId: string): PromiseLike<PostgrestResult<OrderRow>> {
    if (this.existingSelectError) {
      return Promise.resolve({ data: null, error: this.existingSelectError });
    }
    for (const order of this.orders.values()) {
      if (order.quote_id === quoteId) {
        return Promise.resolve({ data: order, error: null });
      }
    }
    return Promise.resolve({ data: null, error: null });
  }
}

/**
 * Adapts a FakeStatusDb's own "orders"/"payments" tables to OrderDbClient --
 * mirrors lib/quote/application.test.ts's quoteDbFromStatusDb(). Used only
 * by the lifecycle tests below, which never call createOrder(), so the
 * Quote-ref/duplicate-check methods are unreachable stubs.
 */
function orderDbFromStatusDb(statusDb: FakeStatusDb): OrderDbClient {
  return {
    insertOrder: () => {
      throw new Error("orderDbFromStatusDb: insertOrder() should not be called by lifecycle tests");
    },
    getOrderById: (id) => {
      const row = statusDb.getRow("orders", id);
      return Promise.resolve({ data: (row ?? null) as unknown as OrderRow | null, error: null });
    },
    getQuoteRef: () => {
      throw new Error("orderDbFromStatusDb: getQuoteRef() should not be called by lifecycle tests");
    },
    getOrderByQuoteId: () => {
      throw new Error(
        "orderDbFromStatusDb: getOrderByQuoteId() should not be called by lifecycle tests",
      );
    },
  };
}

function makeApp(
  db: OrderDbClient = new FakeOrderDb(),
  statusDb: FakeStatusDb = new FakeStatusDb(),
) {
  const runtime = createStateRuntime(statusDb);
  return { app: createOrderApplication({ db, runtime }) };
}

const VALID_INPUT = { quoteId: QUOTE_ID };

function seedEligibleQuote(db: FakeOrderDb, overrides: Partial<QuoteRefRow> = {}): void {
  db.seedQuote({
    id: QUOTE_ID,
    merchant_id: MERCHANT_ID,
    buyer_id: BUYER_ID,
    rfq_id: RFQ_ID,
    total_amount: 114000,
    currency: "INR",
    status: "ACCEPTED",
    ...overrides,
  });
}

describe("createOrder", () => {
  it("creates a valid Order, deriving all fields from the referenced Quote", async () => {
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    const { app } = makeApp(db);

    const order = await app.createOrder(VALID_INPUT);

    assert.equal(order.quoteId, QUOTE_ID);
    assert.equal(order.rfqId, RFQ_ID);
    assert.equal(order.merchantId, MERCHANT_ID);
    assert.equal(order.buyerId, BUYER_ID);
    assert.equal(order.totalAmount, 114000);
    assert.equal(order.currency, "INR");
    assert.equal(typeof order.id, "string");
    assert.equal(typeof order.createdAt, "string");
  });

  it("establishes CREATED as the initial state, without the caller supplying it", async () => {
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    const { app } = makeApp(db);

    const order = await app.createOrder(VALID_INPUT);
    assert.equal(order.status, "CREATED");
  });

  it("rejects a missing quoteId with OrderValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.createOrder({ quoteId: "" }), OrderValidationError);
  });

  it("rejects creation against a nonexistent Quote with OrderQuoteNotFoundError", async () => {
    const { app } = makeApp(new FakeOrderDb());
    await assert.rejects(
      () => app.createOrder({ quoteId: "does-not-exist" }),
      OrderQuoteNotFoundError,
    );
  });

  for (const status of ["DRAFT", "SENT", "NEGOTIATING", "EXPIRED", "REJECTED"] as const) {
    it(`rejects creation against a Quote in state ${status} with OrderQuoteStateError`, async () => {
      const db = new FakeOrderDb();
      seedEligibleQuote(db, { status });
      const { app } = makeApp(db);

      await assert.rejects(() => app.createOrder(VALID_INPUT), OrderQuoteStateError);
    });
  }

  it("allows creation against an ACCEPTED Quote", async () => {
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    const { app } = makeApp(db);

    const order = await app.createOrder(VALID_INPUT);
    assert.equal(order.quoteId, QUOTE_ID);
  });

  it("rejects a second Order against the same Quote with OrderAlreadyExistsError", async () => {
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    const { app } = makeApp(db);

    await app.createOrder(VALID_INPUT);
    await assert.rejects(() => app.createOrder(VALID_INPUT), OrderAlreadyExistsError);
  });

  it("surfaces a Quote-lookup database failure as OrderPersistenceError", async () => {
    const db = new FakeOrderDb();
    db.quoteSelectError = { message: "connection reset" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createOrder(VALID_INPUT), OrderPersistenceError);
  });

  it("surfaces a duplicate-check lookup failure as OrderPersistenceError", async () => {
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    db.existingSelectError = { message: "timeout" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createOrder(VALID_INPUT), OrderPersistenceError);
  });

  it("surfaces an insert failure as OrderPersistenceError", async () => {
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    db.insertError = { message: "duplicate key value violates unique constraint" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createOrder(VALID_INPUT), OrderPersistenceError);
  });
});

describe("getOrderById", () => {
  it("returns an existing Order", async () => {
    const db = new FakeOrderDb();
    db.seedOrder({
      id: "order-1",
      merchant_id: MERCHANT_ID,
      buyer_id: BUYER_ID,
      rfq_id: RFQ_ID,
      quote_id: QUOTE_ID,
      total_amount: 114000,
      currency: "INR",
      status: "CREATED",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const { app } = makeApp(db);

    const order = await app.getOrderById("order-1");
    assert.equal(order.id, "order-1");
    assert.equal(order.status, "CREATED");
  });

  it("throws OrderNotFoundError, not a null return, for a missing Order", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.getOrderById("does-not-exist"), OrderNotFoundError);
  });

  it("surfaces a database failure as OrderPersistenceError, distinct from OrderNotFoundError", async () => {
    const db = new FakeOrderDb();
    db.selectError = { message: "timeout" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.getOrderById("order-1"), OrderPersistenceError);
  });
});

describe("relationship: Quote <-> Order", () => {
  it("the created Order references the Quote (and its RFQ) it was created against", async () => {
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    const { app } = makeApp(db);

    const order = await app.createOrder(VALID_INPUT);
    assert.equal(order.quoteId, QUOTE_ID);
    assert.equal(order.rfqId, RFQ_ID);
  });

  it("the application layer enforces at most one Order per Quote (Core Data Integrity Rule 11), though the schema itself places no unique constraint on quote_id", async () => {
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    const { app } = makeApp(db);

    const first = await app.createOrder(VALID_INPUT);
    await assert.rejects(() => app.createOrder(VALID_INPUT), OrderAlreadyExistsError);

    // Confirm it really was the first Order that blocked the second, not a
    // fluke of never inserting -- getOrderById still finds it afterward.
    const stillThere = await app.getOrderById(first.id);
    assert.equal(stillThere.id, first.id);
  });
});

describe("transitionOrderStatus", () => {
  it("performs a valid transition through lib/runtime and returns the fresh Order", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("orders", { id: "order-1", status: "CREATED" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    const order = await app.transitionOrderStatus({
      orderId: "order-1",
      from: "CREATED",
      to: "PAYMENT_PENDING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(order.id, "order-1");
    assert.equal(order.status, "PAYMENT_PENDING");
    assert.equal(statusDb.getRow("orders", "order-1")?.status, "PAYMENT_PENDING");
  });

  it("rejects a disallowed edge with InvalidTransitionError, propagated unchanged from lib/state-machine", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("orders", { id: "order-1", status: "CREATED" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionOrderStatus({
          orderId: "order-1",
          from: "CREATED",
          to: "PAID", // skips PAYMENT_PENDING; no such edge
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      InvalidTransitionError,
    );
  });

  it("rejects a stale/concurrent transition with StaleTransitionError", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("orders", { id: "order-1", status: "PAYMENT_PENDING" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionOrderStatus({
          orderId: "order-1",
          from: "CREATED", // stale belief; the row is actually PAYMENT_PENDING
          to: "PAYMENT_PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });

  it("goes through lib/runtime: a valid transition produces an audit event", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("orders", { id: "order-1", status: "CREATED" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    await app.transitionOrderStatus({
      orderId: "order-1",
      from: "CREATED",
      to: "PAYMENT_PENDING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(statusDb.tableMap("audit_events").size, 1);
  });

  it("propagates TransitionPersistenceError (reused from lib/state-machine, not swallowed) when the status update fails", async () => {
    const statusDb = new FakeStatusDb({ forcedErrors: { orders: "connection reset" } });
    statusDb.seed("orders", { id: "order-1", status: "CREATED" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionOrderStatus({
          orderId: "order-1",
          from: "CREATED",
          to: "PAYMENT_PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      TransitionPersistenceError,
    );
  });

  it("rejects PAYMENT_PENDING -> PAID with OrderPaymentNotVerifiedError when no Payment for this order has reached PAID", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("orders", { id: "order-1", status: "PAYMENT_PENDING" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionOrderStatus({
          orderId: "order-1",
          from: "PAYMENT_PENDING",
          to: "PAID",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      OrderPaymentNotVerifiedError,
    );
  });

  it("allows PAYMENT_PENDING -> PAID once a Payment for this order has reached PAID", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("orders", { id: "order-1", status: "PAYMENT_PENDING" });
    statusDb.seed("payments", { id: "payment-1", order_id: "order-1", status: "PAID" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    const order = await app.transitionOrderStatus({
      orderId: "order-1",
      from: "PAYMENT_PENDING",
      to: "PAID",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(order.status, "PAID");
  });

  it("rejects PAID -> CONFIRMED with OrderPaymentNotVerifiedError when the backing Payment row is absent", async () => {
    // Order.status can (in this fake) be seeded directly as PAID without a
    // backing Payment row, precisely to prove CONFIRMED re-checks payment
    // verification independently rather than trusting that Order already
    // being PAID implies it.
    const statusDb = new FakeStatusDb();
    statusDb.seed("orders", { id: "order-1", status: "PAID" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionOrderStatus({
          orderId: "order-1",
          from: "PAID",
          to: "CONFIRMED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      OrderPaymentNotVerifiedError,
    );
  });

  it("allows PAID -> CONFIRMED once a Payment for this order has reached PAID", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("orders", { id: "order-1", status: "PAID" });
    statusDb.seed("payments", { id: "payment-1", order_id: "order-1", status: "PAID" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    const order = await app.transitionOrderStatus({
      orderId: "order-1",
      from: "PAID",
      to: "CONFIRMED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(order.status, "CONFIRMED");
  });
});

describe("boundary integrity: the Order application layer never mutates status directly", () => {
  it("the Supabase-backed OrderDbClient exposes only the four intended operations -- no update/patch operation exists to call", () => {
    const client = toOrderDbClient({} as unknown as SupabaseClient);
    assert.deepEqual(Object.keys(client).sort(), [
      "getOrderById",
      "getOrderByQuoteId",
      "getQuoteRef",
      "insertOrder",
    ]);
    assert.equal(Reflect.has(client, "update"), false);
  });

  it("createOrder() and getOrderById() never touch lib/runtime's StatusDbClient at all", async () => {
    const statusDb = new FakeStatusDb();
    const db = new FakeOrderDb();
    seedEligibleQuote(db);
    const { app } = makeApp(db, statusDb);

    await app.createOrder(VALID_INPUT);
    assert.equal(statusDb.calls.length, 0);

    await assert.rejects(() => app.getOrderById("does-not-exist"));
    assert.equal(statusDb.calls.length, 0);
  });

  it("transitionOrderStatus() touches only the table(s) an Order transition legitimately owns", async () => {
    const statusDb = new FakeStatusDb({ allowedTables: ["orders", "audit_events"] });
    statusDb.seed("orders", { id: "order-1", status: "CREATED" });
    const { app } = makeApp(orderDbFromStatusDb(statusDb), statusDb);

    // Would throw synchronously (surfacing as a rejection) if this layer, or
    // anything it calls, reached into a table beyond what a CREATED ->
    // PAYMENT_PENDING Order transition legitimately owns (this edge is not
    // payment-gated, so "payments" is correctly excluded here).
    await app.transitionOrderStatus({
      orderId: "order-1",
      from: "CREATED",
      to: "PAYMENT_PENDING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(statusDb.getRow("orders", "order-1")?.status, "PAYMENT_PENDING");
  });
});

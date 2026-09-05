import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createPaymentApplication } from "./application.ts";
import type { NewPaymentRow, OrderRefRow, PaymentDbClient, PaymentRow } from "./db.ts";
import { toPaymentDbClient } from "./supabase-payment-db.ts";
import {
  PaymentNotFoundError,
  PaymentOrderNotFoundError,
  PaymentOrderStateError,
  PaymentPersistenceError,
  PaymentValidationError,
} from "./errors.ts";
import type { PostgrestResult } from "../state-machine/index.ts";
import { createStateRuntime } from "../runtime/index.ts";
import { FakeStatusDb } from "../state-machine/test-support.ts";
import {
  InvalidTransitionError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "../state-machine/errors.ts";

const MERCHANT_ID = "merchant-1";
const QUOTE_ID = "quote-1";
const ORDER_ID = "order-1";

/**
 * Self-contained in-memory fake of PaymentDbClient -- mirrors
 * lib/order/application.test.ts's FakeOrderDb. Used for creation/retrieval
 * tests, which never touch lib/runtime.
 */
class FakePaymentDb implements PaymentDbClient {
  private readonly payments = new Map<string, PaymentRow>();
  private readonly orders = new Map<string, OrderRefRow>();
  private nextId = 1;
  insertError: { message: string } | null = null;
  selectError: { message: string } | null = null;
  orderSelectError: { message: string } | null = null;

  seedPayment(row: PaymentRow): void {
    this.payments.set(row.id, row);
  }

  seedOrder(row: OrderRefRow): void {
    this.orders.set(row.id, row);
  }

  insertPayment(row: NewPaymentRow): PromiseLike<PostgrestResult<PaymentRow>> {
    if (this.insertError) {
      return Promise.resolve({ data: null, error: this.insertError });
    }
    const now = new Date().toISOString();
    const stored: PaymentRow = {
      id: `payment-${this.nextId++}`,
      order_id: row.order_id,
      quote_id: row.quote_id,
      razorpay_order_id: row.razorpay_order_id ?? null,
      razorpay_payment_link_id: row.razorpay_payment_link_id ?? null,
      amount: row.amount,
      currency: row.currency,
      status: "CREATED",
      created_at: now,
      updated_at: now,
    };
    this.payments.set(stored.id, stored);
    return Promise.resolve({ data: stored, error: null });
  }

  getPaymentById(id: string): PromiseLike<PostgrestResult<PaymentRow>> {
    if (this.selectError) {
      return Promise.resolve({ data: null, error: this.selectError });
    }
    return Promise.resolve({ data: this.payments.get(id) ?? null, error: null });
  }

  getOrderRef(orderId: string): PromiseLike<PostgrestResult<OrderRefRow>> {
    if (this.orderSelectError) {
      return Promise.resolve({ data: null, error: this.orderSelectError });
    }
    return Promise.resolve({ data: this.orders.get(orderId) ?? null, error: null });
  }
}

/**
 * Adapts a FakeStatusDb's own "payments" table to PaymentDbClient -- mirrors
 * lib/order/application.test.ts's orderDbFromStatusDb(). Used only by the
 * lifecycle tests below, which never call createPayment(), so the
 * Order-ref method is an unreachable stub.
 */
function paymentDbFromStatusDb(statusDb: FakeStatusDb): PaymentDbClient {
  return {
    insertPayment: () => {
      throw new Error(
        "paymentDbFromStatusDb: insertPayment() should not be called by lifecycle tests",
      );
    },
    getPaymentById: (id) => {
      const row = statusDb.getRow("payments", id);
      return Promise.resolve({ data: (row ?? null) as unknown as PaymentRow | null, error: null });
    },
    getOrderRef: () => {
      throw new Error(
        "paymentDbFromStatusDb: getOrderRef() should not be called by lifecycle tests",
      );
    },
  };
}

function makeApp(
  db: PaymentDbClient = new FakePaymentDb(),
  statusDb: FakeStatusDb = new FakeStatusDb(),
) {
  const runtime = createStateRuntime(statusDb);
  return { app: createPaymentApplication({ db, runtime }) };
}

const VALID_INPUT = { orderId: ORDER_ID };

function seedEligibleOrder(db: FakePaymentDb, overrides: Partial<OrderRefRow> = {}): void {
  db.seedOrder({
    id: ORDER_ID,
    quote_id: QUOTE_ID,
    total_amount: 114000,
    currency: "INR",
    status: "CREATED",
    ...overrides,
  });
}

describe("createPayment", () => {
  it("creates a valid Payment, deriving amount/currency/quoteId from the referenced Order", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    const { app } = makeApp(db);

    const payment = await app.createPayment(VALID_INPUT);

    assert.equal(payment.orderId, ORDER_ID);
    assert.equal(payment.quoteId, QUOTE_ID);
    assert.equal(payment.amount, 114000);
    assert.equal(payment.currency, "INR");
    assert.equal(typeof payment.id, "string");
    assert.equal(typeof payment.createdAt, "string");
  });

  it("establishes CREATED as the initial state, without the caller supplying it", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    const { app } = makeApp(db);

    const payment = await app.createPayment(VALID_INPUT);
    assert.equal(payment.status, "CREATED");
  });

  it("stores caller-provided razorpayOrderId/razorpayPaymentLinkId", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    const { app } = makeApp(db);

    const payment = await app.createPayment({
      orderId: ORDER_ID,
      razorpayOrderId: "razorpay-order-abc",
      razorpayPaymentLinkId: "razorpay-link-xyz",
    });

    assert.equal(payment.razorpayOrderId, "razorpay-order-abc");
    assert.equal(payment.razorpayPaymentLinkId, "razorpay-link-xyz");
  });

  it("stores null for razorpayOrderId/razorpayPaymentLinkId when omitted -- no live Razorpay call is made to obtain them", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    const { app } = makeApp(db);

    const payment = await app.createPayment(VALID_INPUT);

    assert.equal(payment.razorpayOrderId, null);
    assert.equal(payment.razorpayPaymentLinkId, null);
  });

  it("rejects a missing orderId with PaymentValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.createPayment({ orderId: "" }), PaymentValidationError);
  });

  it("rejects an explicitly-provided empty-string razorpayOrderId with PaymentValidationError", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    const { app } = makeApp(db);

    await assert.rejects(
      () => app.createPayment({ orderId: ORDER_ID, razorpayOrderId: "" }),
      PaymentValidationError,
    );
  });

  it("rejects an explicitly-provided empty-string razorpayPaymentLinkId with PaymentValidationError", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    const { app } = makeApp(db);

    await assert.rejects(
      () => app.createPayment({ orderId: ORDER_ID, razorpayPaymentLinkId: "" }),
      PaymentValidationError,
    );
  });

  it("rejects creation against a nonexistent Order with PaymentOrderNotFoundError", async () => {
    const { app } = makeApp(new FakePaymentDb());
    await assert.rejects(
      () => app.createPayment({ orderId: "does-not-exist" }),
      PaymentOrderNotFoundError,
    );
  });

  for (const status of ["PAID", "CONFIRMED", "PAYMENT_FAILED", "CANCELLED"] as const) {
    it(`rejects creation against an Order in state ${status} with PaymentOrderStateError`, async () => {
      const db = new FakePaymentDb();
      seedEligibleOrder(db, { status });
      const { app } = makeApp(db);

      await assert.rejects(() => app.createPayment(VALID_INPUT), PaymentOrderStateError);
    });
  }

  it("allows creation against a CREATED Order (the first payment attempt)", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db, { status: "CREATED" });
    const { app } = makeApp(db);

    const payment = await app.createPayment(VALID_INPUT);
    assert.equal(payment.orderId, ORDER_ID);
  });

  it("allows creation against a PAYMENT_PENDING Order (a retried payment attempt)", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db, { status: "PAYMENT_PENDING" });
    const { app } = makeApp(db);

    const payment = await app.createPayment(VALID_INPUT);
    assert.equal(payment.orderId, ORDER_ID);
  });

  it("surfaces an Order-lookup database failure as PaymentPersistenceError", async () => {
    const db = new FakePaymentDb();
    db.orderSelectError = { message: "connection reset" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createPayment(VALID_INPUT), PaymentPersistenceError);
  });

  it("surfaces an insert failure as PaymentPersistenceError", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    db.insertError = { message: "duplicate key value violates unique constraint" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createPayment(VALID_INPUT), PaymentPersistenceError);
  });
});

describe("getPaymentById", () => {
  it("returns an existing Payment", async () => {
    const db = new FakePaymentDb();
    db.seedPayment({
      id: "payment-1",
      order_id: ORDER_ID,
      quote_id: QUOTE_ID,
      razorpay_order_id: null,
      razorpay_payment_link_id: null,
      amount: 114000,
      currency: "INR",
      status: "CREATED",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const { app } = makeApp(db);

    const payment = await app.getPaymentById("payment-1");
    assert.equal(payment.id, "payment-1");
    assert.equal(payment.status, "CREATED");
  });

  it("throws PaymentNotFoundError, not a null return, for a missing Payment", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.getPaymentById("does-not-exist"), PaymentNotFoundError);
  });

  it("surfaces a database failure as PaymentPersistenceError, distinct from PaymentNotFoundError", async () => {
    const db = new FakePaymentDb();
    db.selectError = { message: "timeout" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.getPaymentById("payment-1"), PaymentPersistenceError);
  });
});

describe("relationship: Order <-> Payment", () => {
  it("the created Payment references the Order (and its Quote) it was created against", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    const { app } = makeApp(db);

    const payment = await app.createPayment(VALID_INPUT);
    assert.equal(payment.orderId, ORDER_ID);
    assert.equal(payment.quoteId, QUOTE_ID);
  });

  it("allows multiple Payment attempts against the same Order (Core Data Integrity Rule 13), unlike Order/Quote which are guarded to one-to-one", async () => {
    const db = new FakePaymentDb();
    seedEligibleOrder(db, { status: "PAYMENT_PENDING" });
    const { app } = makeApp(db);

    const first = await app.createPayment(VALID_INPUT);
    const second = await app.createPayment(VALID_INPUT);

    assert.notEqual(first.id, second.id);
    assert.equal(first.orderId, ORDER_ID);
    assert.equal(second.orderId, ORDER_ID);
  });
});

describe("transitionPaymentStatus", () => {
  it("performs a valid transition through lib/runtime and returns the fresh Payment", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("payments", { id: "payment-1", status: "CREATED" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    const payment = await app.transitionPaymentStatus({
      paymentId: "payment-1",
      from: "CREATED",
      to: "PENDING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(payment.id, "payment-1");
    assert.equal(payment.status, "PENDING");
    assert.equal(statusDb.getRow("payments", "payment-1")?.status, "PENDING");
  });

  it("rejects a disallowed edge with InvalidTransitionError, propagated unchanged from lib/state-machine", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("payments", { id: "payment-1", status: "PENDING" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionPaymentStatus({
          paymentId: "payment-1",
          from: "PENDING",
          to: "CREATED", // PENDING has no edge back to CREATED
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      InvalidTransitionError,
    );
  });

  it("rejects a stale/concurrent transition with StaleTransitionError", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("payments", { id: "payment-1", status: "PENDING" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionPaymentStatus({
          paymentId: "payment-1",
          from: "CREATED", // stale belief; the row is actually PENDING
          to: "PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });

  it("goes through lib/runtime: a valid transition produces an audit event", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("payments", { id: "payment-1", status: "CREATED" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await app.transitionPaymentStatus({
      paymentId: "payment-1",
      from: "CREATED",
      to: "PENDING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(statusDb.tableMap("audit_events").size, 1);
  });

  it("propagates TransitionPersistenceError (reused from lib/state-machine, not swallowed) when the status update fails", async () => {
    const statusDb = new FakeStatusDb({ forcedErrors: { payments: "connection reset" } });
    statusDb.seed("payments", { id: "payment-1", status: "CREATED" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionPaymentStatus({
          paymentId: "payment-1",
          from: "CREATED",
          to: "PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      TransitionPersistenceError,
    );
  });
});

describe("markPaymentPaid", () => {
  it("moves a PENDING Payment to PAID given verification evidence, and returns the fresh Payment", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("payments", { id: "payment-1", status: "PENDING" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    const payment = await app.markPaymentPaid({
      paymentId: "payment-1",
      from: "PENDING",
      merchantId: MERCHANT_ID,
      verification: {
        razorpayPaymentId: "pay_test123",
        verifiedVia: "RAZORPAY_WEBHOOK",
      },
    });

    assert.equal(payment.id, "payment-1");
    assert.equal(payment.status, "PAID");
    assert.equal(statusDb.getRow("payments", "payment-1")?.status, "PAID");
  });

  it("rejects an invalid `from` (CREATED cannot reach PAID directly) with InvalidTransitionError", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("payments", { id: "payment-1", status: "CREATED" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.markPaymentPaid({
          paymentId: "payment-1",
          from: "CREATED",
          merchantId: MERCHANT_ID,
          verification: {
            razorpayPaymentId: "pay_test123",
            verifiedVia: "RAZORPAY_WEBHOOK",
          },
        }),
      InvalidTransitionError,
    );
  });

  it("rejects a stale `from` with StaleTransitionError", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("payments", { id: "payment-1", status: "FAILED" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.markPaymentPaid({
          paymentId: "payment-1",
          from: "PENDING", // stale belief; the row is actually FAILED
          merchantId: MERCHANT_ID,
          verification: {
            razorpayPaymentId: "pay_test123",
            verifiedVia: "RAZORPAY_API_STATUS_CHECK",
          },
        }),
      StaleTransitionError,
    );
  });

  it("goes through lib/runtime: marking paid produces an audit event", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("payments", { id: "payment-1", status: "PENDING" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await app.markPaymentPaid({
      paymentId: "payment-1",
      from: "PENDING",
      merchantId: MERCHANT_ID,
      verification: {
        razorpayPaymentId: "pay_test123",
        verifiedVia: "RAZORPAY_WEBHOOK",
      },
    });

    assert.equal(statusDb.tableMap("audit_events").size, 1);
  });
});

describe("boundary integrity: the Payment application layer never mutates status directly", () => {
  it("the Supabase-backed PaymentDbClient exposes only the three intended operations -- no update/patch operation exists to call", () => {
    const client = toPaymentDbClient({} as unknown as SupabaseClient);
    assert.deepEqual(Object.keys(client).sort(), ["getOrderRef", "getPaymentById", "insertPayment"]);
    assert.equal(Reflect.has(client, "update"), false);
  });

  it("createPayment() and getPaymentById() never touch lib/runtime's StatusDbClient at all", async () => {
    const statusDb = new FakeStatusDb();
    const db = new FakePaymentDb();
    seedEligibleOrder(db);
    const { app } = makeApp(db, statusDb);

    await app.createPayment(VALID_INPUT);
    assert.equal(statusDb.calls.length, 0);

    await assert.rejects(() => app.getPaymentById("does-not-exist"));
    assert.equal(statusDb.calls.length, 0);
  });

  it("transitionPaymentStatus() touches only the table(s) a Payment transition legitimately owns", async () => {
    const statusDb = new FakeStatusDb({ allowedTables: ["payments", "audit_events"] });
    statusDb.seed("payments", { id: "payment-1", status: "CREATED" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await app.transitionPaymentStatus({
      paymentId: "payment-1",
      from: "CREATED",
      to: "PENDING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(statusDb.getRow("payments", "payment-1")?.status, "PENDING");
  });

  it("markPaymentPaid() touches only the table(s) a Payment mark-paid legitimately owns", async () => {
    const statusDb = new FakeStatusDb({ allowedTables: ["payments", "audit_events"] });
    statusDb.seed("payments", { id: "payment-1", status: "PENDING" });
    const { app } = makeApp(paymentDbFromStatusDb(statusDb), statusDb);

    await app.markPaymentPaid({
      paymentId: "payment-1",
      from: "PENDING",
      merchantId: MERCHANT_ID,
      verification: {
        razorpayPaymentId: "pay_test123",
        verifiedVia: "RAZORPAY_WEBHOOK",
      },
    });

    assert.equal(statusDb.getRow("payments", "payment-1")?.status, "PAID");
  });
});

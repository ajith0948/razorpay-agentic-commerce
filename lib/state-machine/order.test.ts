import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ORDER_TRANSITIONS, transitionOrder } from "./order.ts";
import { ORDER_STATUSES, type OrderStatus } from "./types.ts";
import { FakeStatusDb } from "./test-support.ts";
import {
  AuditWriteError,
  InvalidTransitionError,
  OrderPaymentNotVerifiedError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "./errors.ts";

const MERCHANT_ID = "merchant-1";
const ORDER_ID = "order-1";
const OTHER_ORDER_ID = "order-2";
const PAYMENT_ID = "payment-1";

function seedOrder(db: FakeStatusDb, status: OrderStatus, id: string = ORDER_ID) {
  db.seed("orders", { id, status });
}

function seedPaidPayment(db: FakeStatusDb, orderId: string, id: string = PAYMENT_ID) {
  db.seed("payments", { id, order_id: orderId, status: "PAID" });
}

const PAYMENT_GATED_STATUSES: ReadonlySet<OrderStatus> = new Set(["PAID", "CONFIRMED"]);

// Documented edges that do NOT require a verified payment.
const NON_PAYMENT_EDGES: Array<{ from: OrderStatus; to: OrderStatus }> = ORDER_STATUSES.flatMap(
  (from) =>
    ORDER_TRANSITIONS[from]
      .filter((to) => !PAYMENT_GATED_STATUSES.has(to))
      .map((to) => ({ from, to })),
);

describe("transitionOrder: valid edges not requiring payment verification", () => {
  for (const { from, to } of NON_PAYMENT_EDGES) {
    it(`allows ${from} -> ${to} with no payments row seeded`, async () => {
      const db = new FakeStatusDb();
      seedOrder(db, from);

      await transitionOrder({
        client: db,
        orderId: ORDER_ID,
        from,
        to,
        merchantId: MERCHANT_ID,
        actorType: "SYSTEM",
      });

      assert.equal(db.getRow("orders", ORDER_ID)?.status, to);
      const events = [...db.tableMap("audit_events").values()];
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, "ORDER_STATUS_CHANGED");
    });
  }
});

describe("transitionOrder: PAID and CONFIRMED require a verified payment", () => {
  it("rejects PAYMENT_PENDING -> PAID with no paid payment row for this order, and writes no audit event", async () => {
    const db = new FakeStatusDb();
    seedOrder(db, "PAYMENT_PENDING");

    try {
      await transitionOrder({
        client: db,
        orderId: ORDER_ID,
        from: "PAYMENT_PENDING",
        to: "PAID",
        merchantId: MERCHANT_ID,
        actorType: "SYSTEM",
      });
      assert.fail("expected transitionOrder to reject");
    } catch (err) {
      assert.ok(err instanceof OrderPaymentNotVerifiedError);
      assert.equal(err.orderId, ORDER_ID);
      assert.equal(err.attemptedStatus, "PAID");
    }

    assert.equal(db.getRow("orders", ORDER_ID)?.status, "PAYMENT_PENDING");
    assert.equal(db.tableMap("audit_events").size, 0);
  });

  it("allows PAYMENT_PENDING -> PAID once a PAID payment row exists for this order", async () => {
    const db = new FakeStatusDb();
    seedOrder(db, "PAYMENT_PENDING");
    seedPaidPayment(db, ORDER_ID);

    await transitionOrder({
      client: db,
      orderId: ORDER_ID,
      from: "PAYMENT_PENDING",
      to: "PAID",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(db.getRow("orders", ORDER_ID)?.status, "PAID");
  });

  it("allows PAID -> CONFIRMED when a PAID payment row exists, and writes an ORDER_CONFIRMED audit event", async () => {
    const db = new FakeStatusDb();
    seedOrder(db, "PAID");
    seedPaidPayment(db, ORDER_ID);

    await transitionOrder({
      client: db,
      orderId: ORDER_ID,
      from: "PAID",
      to: "CONFIRMED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(db.getRow("orders", ORDER_ID)?.status, "CONFIRMED");
    const events = [...db.tableMap("audit_events").values()];
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "ORDER_CONFIRMED");
  });

  it("rejects PAID -> CONFIRMED if, hypothetically, no payment row is actually verified (defense in depth)", async () => {
    const db = new FakeStatusDb();
    seedOrder(db, "PAID"); // no payments row seeded at all

    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: ORDER_ID,
          from: "PAID",
          to: "CONFIRMED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      OrderPaymentNotVerifiedError,
    );
  });

  it("a PAID payment belonging to a different order does not verify this order (order_id isolation)", async () => {
    const db = new FakeStatusDb();
    seedOrder(db, "PAYMENT_PENDING", ORDER_ID);
    seedOrder(db, "PAYMENT_PENDING", OTHER_ORDER_ID);
    seedPaidPayment(db, OTHER_ORDER_ID); // paid, but for the *other* order

    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: ORDER_ID,
          from: "PAYMENT_PENDING",
          to: "PAID",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      OrderPaymentNotVerifiedError,
    );

    assert.equal(db.getRow("orders", ORDER_ID)?.status, "PAYMENT_PENDING");
  });
});

describe("transitionOrder: an already-PAID order cannot return to PAYMENT_PENDING", () => {
  it("rejects PAID -> PAYMENT_PENDING", async () => {
    const db = new FakeStatusDb();
    seedOrder(db, "PAID");
    seedPaidPayment(db, ORDER_ID);

    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: ORDER_ID,
          from: "PAID",
          to: "PAYMENT_PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      InvalidTransitionError,
    );
  });
});

describe("transitionOrder: invalid edges / terminal states", () => {
  it("does not let PAYMENT_FAILED retry back to PAYMENT_PENDING (a retry creates a new Payment row instead)", async () => {
    const db = new FakeStatusDb();
    seedOrder(db, "PAYMENT_FAILED");

    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: ORDER_ID,
          from: "PAYMENT_FAILED",
          to: "PAYMENT_PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      InvalidTransitionError,
    );
  });

  for (const terminal of ["CONFIRMED", "PAYMENT_FAILED", "CANCELLED"] as const) {
    it(`rejects every transition out of terminal state ${terminal}`, async () => {
      const db = new FakeStatusDb();
      seedOrder(db, terminal);
      seedPaidPayment(db, ORDER_ID); // present so any PAID/CONFIRMED attempt fails on table lookup, not payment verification

      for (const to of ORDER_STATUSES) {
        if (to === terminal) continue;
        await assert.rejects(
          () =>
            transitionOrder({
              client: db,
              orderId: ORDER_ID,
              from: terminal,
              to,
              merchantId: MERCHANT_ID,
              actorType: "SYSTEM",
            }),
          InvalidTransitionError,
        );
      }
    });
  }
});

describe("transitionOrder: independence from RFQ state", () => {
  it("never touches the rfqs table", async () => {
    const db = new FakeStatusDb({ allowedTables: ["orders", "payments", "audit_events"] });
    seedOrder(db, "CREATED");

    await transitionOrder({
      client: db,
      orderId: ORDER_ID,
      from: "CREATED",
      to: "CANCELLED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(db.getRow("orders", ORDER_ID)?.status, "CANCELLED");
  });
});

describe("transitionOrder: stale/concurrent updates", () => {
  it("throws StaleTransitionError when the row's real status no longer matches `from`", async () => {
    const db = new FakeStatusDb();
    seedOrder(db, "PAYMENT_PENDING");

    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: ORDER_ID,
          from: "CREATED", // stale belief; row is actually PAYMENT_PENDING
          to: "PAYMENT_PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });

  it("throws StaleTransitionError when the row does not exist at all", async () => {
    const db = new FakeStatusDb();
    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: "does-not-exist",
          from: "CREATED",
          to: "CANCELLED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });
});

describe("transitionOrder: database error propagation", () => {
  it("throws TransitionPersistenceError when the orders update itself fails", async () => {
    const db = new FakeStatusDb({ forcedErrors: { orders: "connection reset" } });
    seedOrder(db, "CREATED");

    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: ORDER_ID,
          from: "CREATED",
          to: "CANCELLED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      TransitionPersistenceError,
    );
  });

  it("throws TransitionPersistenceError when the payments verification lookup itself fails", async () => {
    const db = new FakeStatusDb({ forcedErrors: { payments: "connection reset" } });
    seedOrder(db, "PAYMENT_PENDING");

    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: ORDER_ID,
          from: "PAYMENT_PENDING",
          to: "PAID",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      TransitionPersistenceError,
    );
  });

  it("throws AuditWriteError when the audit insert fails (status is not rolled back)", async () => {
    const db = new FakeStatusDb({ forcedErrors: { audit_events: "insert rejected" } });
    seedOrder(db, "CREATED");

    await assert.rejects(
      () =>
        transitionOrder({
          client: db,
          orderId: ORDER_ID,
          from: "CREATED",
          to: "CANCELLED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      AuditWriteError,
    );

    assert.equal(db.getRow("orders", ORDER_ID)?.status, "CANCELLED");
  });
});

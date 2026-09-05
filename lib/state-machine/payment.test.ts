import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { markPaymentPaid, PAYMENT_TRANSITIONS, transitionPayment } from "./payment.ts";
import { PAYMENT_STATUSES, type PaymentStatus } from "./types.ts";
import { FakeStatusDb } from "./test-support.ts";
import {
  AuditWriteError,
  InvalidTransitionError,
  PaymentPaidRequiresVerificationError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "./errors.ts";

const MERCHANT_ID = "merchant-1";
const PAYMENT_ID = "payment-1";

function seedPayment(db: FakeStatusDb, status: PaymentStatus) {
  db.seed("payments", { id: PAYMENT_ID, status });
}

/** Mirrors payment.ts's private paymentEventType() -- see that file's doc comment. */
function expectedEventType(to: Exclude<PaymentStatus, "PAID">): string {
  if (to === "FAILED") return "PAYMENT_FAILED";
  return "PAYMENT_STATUS_CHANGED";
}

// Every documented edge except *->PAID, which only markPaymentPaid() may take.
const NON_PAID_EDGES: Array<{ from: PaymentStatus; to: Exclude<PaymentStatus, "PAID"> }> =
  PAYMENT_STATUSES.flatMap((from) =>
    PAYMENT_TRANSITIONS[from]
      .filter((to): to is Exclude<PaymentStatus, "PAID"> => to !== "PAID")
      .map((to) => ({ from, to })),
  );

describe("transitionPayment: valid edges (excluding PAID)", () => {
  for (const { from, to } of NON_PAID_EDGES) {
    it(`allows ${from} -> ${to} and writes a ${expectedEventType(to)} audit event`, async () => {
      const db = new FakeStatusDb();
      seedPayment(db, from);

      await transitionPayment({
        client: db,
        paymentId: PAYMENT_ID,
        from,
        to,
        merchantId: MERCHANT_ID,
        actorType: "SYSTEM",
      });

      assert.equal(db.getRow("payments", PAYMENT_ID)?.status, to);

      const events = [...db.tableMap("audit_events").values()];
      assert.equal(events.length, 1);
      assert.equal(events[0].event_type, expectedEventType(to));
      assert.equal(events[0].payment_id, undefined); // audit_events has no payment_id column
    });
  }
});

describe("transitionPayment: PAID cannot be reached through transitionPayment()", () => {
  it("throws PaymentPaidRequiresVerificationError before touching the database, even if a caller bypasses the type system", async () => {
    const db = new FakeStatusDb();
    seedPayment(db, "PENDING");

    // Simulates an untyped/LLM-driven caller: the Exclude<PaymentStatus,
    // "PAID"> param type already stops a typechecked caller from doing
    // this, so the runtime guard is what this test is really proving.
    const forcedPaid = "PAID" as unknown as Exclude<PaymentStatus, "PAID">;

    try {
      await transitionPayment({
        client: db,
        paymentId: PAYMENT_ID,
        from: "PENDING",
        to: forcedPaid,
        merchantId: MERCHANT_ID,
        actorType: "SYSTEM",
      });
      assert.fail("expected transitionPayment to reject");
    } catch (err) {
      assert.ok(err instanceof PaymentPaidRequiresVerificationError);
      assert.equal(err.paymentId, PAYMENT_ID);
    }

    // The guard fires before any DB call -- proves this is not merely a
    // rejected UPDATE, but a check that never reaches the database at all.
    assert.equal(db.calls.length, 0);
    assert.equal(db.getRow("payments", PAYMENT_ID)?.status, "PENDING");
  });
});

describe("transitionPayment: invalid edges", () => {
  it("rejects CREATED -> FAILED (not a documented edge)", async () => {
    const db = new FakeStatusDb();
    seedPayment(db, "CREATED");
    await assert.rejects(
      () =>
        transitionPayment({
          client: db,
          paymentId: PAYMENT_ID,
          from: "CREATED",
          to: "FAILED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      InvalidTransitionError,
    );
  });

  for (const terminal of ["PAID", "FAILED"] as const) {
    it(`rejects every transition out of terminal state ${terminal}`, async () => {
      const db = new FakeStatusDb();
      seedPayment(db, terminal);

      for (const to of PAYMENT_STATUSES) {
        if (to === terminal || to === "PAID") continue; // PAID is covered by the dedicated block-test above
        await assert.rejects(
          () =>
            transitionPayment({
              client: db,
              paymentId: PAYMENT_ID,
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

describe("transitionPayment: stale/concurrent updates", () => {
  it("throws StaleTransitionError when the row's real status no longer matches `from`", async () => {
    const db = new FakeStatusDb();
    seedPayment(db, "PENDING");

    await assert.rejects(
      () =>
        transitionPayment({
          client: db,
          paymentId: PAYMENT_ID,
          from: "CREATED", // stale belief; row is actually PENDING
          to: "PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });
});

describe("transitionPayment: database error propagation", () => {
  it("throws TransitionPersistenceError when the update itself fails", async () => {
    const db = new FakeStatusDb({ forcedErrors: { payments: "connection reset" } });
    seedPayment(db, "CREATED");

    await assert.rejects(
      () =>
        transitionPayment({
          client: db,
          paymentId: PAYMENT_ID,
          from: "CREATED",
          to: "PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      TransitionPersistenceError,
    );
  });

  it("throws AuditWriteError when the audit insert fails (status is not rolled back)", async () => {
    const db = new FakeStatusDb({ forcedErrors: { audit_events: "insert rejected" } });
    seedPayment(db, "CREATED");

    await assert.rejects(
      () =>
        transitionPayment({
          client: db,
          paymentId: PAYMENT_ID,
          from: "CREATED",
          to: "PENDING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      AuditWriteError,
    );

    assert.equal(db.getRow("payments", PAYMENT_ID)?.status, "PENDING");
  });
});

describe("markPaymentPaid: the only path to PAID", () => {
  it("moves PENDING -> PAID, fixes actorType to RAZORPAY, and records verification evidence in the audit event", async () => {
    const db = new FakeStatusDb();
    seedPayment(db, "PENDING");

    await markPaymentPaid({
      client: db,
      paymentId: PAYMENT_ID,
      from: "PENDING",
      merchantId: MERCHANT_ID,
      verification: {
        razorpayPaymentId: "pay_test123",
        verifiedVia: "RAZORPAY_WEBHOOK",
      },
    });

    assert.equal(db.getRow("payments", PAYMENT_ID)?.status, "PAID");

    const events = [...db.tableMap("audit_events").values()];
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "PAYMENT_CONFIRMED");
    assert.equal(events[0].actor_type, "RAZORPAY");
    assert.equal(events[0].input_summary, "razorpayPaymentId=pay_test123");
    assert.equal(events[0].output_summary, "verifiedVia=RAZORPAY_WEBHOOK");
  });

  it("rejects CREATED -> PAID (skipping PENDING)", async () => {
    const db = new FakeStatusDb();
    seedPayment(db, "CREATED");

    await assert.rejects(
      () =>
        markPaymentPaid({
          client: db,
          paymentId: PAYMENT_ID,
          from: "CREATED",
          merchantId: MERCHANT_ID,
          verification: { razorpayPaymentId: "pay_test123", verifiedVia: "RAZORPAY_WEBHOOK" },
        }),
      InvalidTransitionError,
    );
  });

  it("rejects FAILED -> PAID (terminal state)", async () => {
    const db = new FakeStatusDb();
    seedPayment(db, "FAILED");

    await assert.rejects(
      () =>
        markPaymentPaid({
          client: db,
          paymentId: PAYMENT_ID,
          from: "FAILED",
          merchantId: MERCHANT_ID,
          verification: { razorpayPaymentId: "pay_test123", verifiedVia: "RAZORPAY_API_STATUS_CHECK" },
        }),
      InvalidTransitionError,
    );
  });

  it("rejects PAID -> PAID (an already-PAID payment cannot be marked paid again)", async () => {
    const db = new FakeStatusDb();
    seedPayment(db, "PAID");

    await assert.rejects(
      () =>
        markPaymentPaid({
          client: db,
          paymentId: PAYMENT_ID,
          from: "PAID",
          merchantId: MERCHANT_ID,
          verification: { razorpayPaymentId: "pay_test123", verifiedVia: "RAZORPAY_WEBHOOK" },
        }),
      InvalidTransitionError,
    );
  });

  it("throws StaleTransitionError when the row's real status no longer matches `from`", async () => {
    const db = new FakeStatusDb();
    seedPayment(db, "CREATED"); // caller believes PENDING, row is actually CREATED

    await assert.rejects(
      () =>
        markPaymentPaid({
          client: db,
          paymentId: PAYMENT_ID,
          from: "PENDING",
          merchantId: MERCHANT_ID,
          verification: { razorpayPaymentId: "pay_test123", verifiedVia: "RAZORPAY_WEBHOOK" },
        }),
      StaleTransitionError,
    );
  });
});

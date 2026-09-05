import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RFQ_TRANSITIONS, transitionRfq } from "./rfq.ts";
import { RFQ_STATUSES, type RfqStatus } from "./types.ts";
import { FakeStatusDb } from "./test-support.ts";
import {
  AuditWriteError,
  InvalidTransitionError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "./errors.ts";

const MERCHANT_ID = "merchant-1";
const RFQ_ID = "rfq-1";

function seedRfq(db: FakeStatusDb, status: RfqStatus) {
  db.seed("rfqs", { id: RFQ_ID, status });
}

describe("transitionRfq: valid edges", () => {
  for (const from of RFQ_STATUSES) {
    for (const to of RFQ_TRANSITIONS[from]) {
      it(`allows ${from} -> ${to} and writes an audit event`, async () => {
        const db = new FakeStatusDb();
        seedRfq(db, from);

        await transitionRfq({
          client: db,
          rfqId: RFQ_ID,
          from,
          to,
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        });

        assert.equal(db.getRow("rfqs", RFQ_ID)?.status, to);

        const events = [...db.tableMap("audit_events").values()];
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, "RFQ_STATUS_CHANGED");
        assert.equal(events[0].rfq_id, RFQ_ID);
        assert.equal(events[0].merchant_id, MERCHANT_ID);
        assert.equal(events[0].actor_type, "SYSTEM");
      });
    }
  }
});

describe("transitionRfq: invalid edges", () => {
  it("rejects a transition not in RFQ_TRANSITIONS, with no side effects", async () => {
    const db = new FakeStatusDb();
    seedRfq(db, "ACCEPTED");

    try {
      await transitionRfq({
        client: db,
        rfqId: RFQ_ID,
        from: "ACCEPTED",
        to: "QUOTED",
        merchantId: MERCHANT_ID,
        actorType: "SYSTEM",
      });
      assert.fail("expected transitionRfq to reject");
    } catch (err) {
      assert.ok(err instanceof InvalidTransitionError);
      assert.equal(err.entity, "RFQ");
      assert.equal(err.from, "ACCEPTED");
      assert.equal(err.to, "QUOTED");
    }

    assert.equal(db.getRow("rfqs", RFQ_ID)?.status, "ACCEPTED");
    assert.equal(db.tableMap("audit_events").size, 0);
  });

  for (const terminal of ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED", "FAILED"] as const) {
    it(`rejects every transition out of terminal state ${terminal}`, async () => {
      const db = new FakeStatusDb();
      seedRfq(db, terminal);

      for (const to of RFQ_STATUSES) {
        if (to === terminal) continue;
        await assert.rejects(
          () =>
            transitionRfq({
              client: db,
              rfqId: RFQ_ID,
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

  it("a rejected/expired/cancelled RFQ specifically cannot become ACCEPTED", async () => {
    for (const from of ["REJECTED", "EXPIRED", "CANCELLED"] as const) {
      const db = new FakeStatusDb();
      seedRfq(db, from);
      await assert.rejects(
        () =>
          transitionRfq({
            client: db,
            rfqId: RFQ_ID,
            from,
            to: "ACCEPTED",
            merchantId: MERCHANT_ID,
            actorType: "SYSTEM",
          }),
        InvalidTransitionError,
      );
    }
  });
});

describe("transitionRfq: stale/concurrent updates", () => {
  it("throws StaleTransitionError when the row's real status no longer matches `from`", async () => {
    const db = new FakeStatusDb();
    seedRfq(db, "PROCESSING");

    try {
      await transitionRfq({
        client: db,
        rfqId: RFQ_ID,
        from: "CREATED", // stale belief; row is actually PROCESSING
        to: "PROCESSING",
        merchantId: MERCHANT_ID,
        actorType: "SYSTEM",
      });
      assert.fail("expected transitionRfq to reject");
    } catch (err) {
      assert.ok(err instanceof StaleTransitionError);
      assert.equal(err.table, "rfqs");
      assert.equal(err.id, RFQ_ID);
    }
  });

  it("throws StaleTransitionError when the row does not exist at all", async () => {
    const db = new FakeStatusDb();
    await assert.rejects(
      () =>
        transitionRfq({
          client: db,
          rfqId: "does-not-exist",
          from: "CREATED",
          to: "PROCESSING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });
});

describe("transitionRfq: independence from Order/Payment state", () => {
  it("never touches the orders or payments tables", async () => {
    const db = new FakeStatusDb({ allowedTables: ["rfqs", "audit_events"] });
    seedRfq(db, "CREATED");

    await transitionRfq({
      client: db,
      rfqId: RFQ_ID,
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    // FakeStatusDb.beginOp() throws synchronously the moment anything
    // touches a table outside allowedTables, so simply completing without
    // throwing already proves the independence; this also confirms the
    // transition still ran to completion.
    assert.equal(db.getRow("rfqs", RFQ_ID)?.status, "PROCESSING");
  });
});

describe("transitionRfq: structuredRequirements (extraPatch)", () => {
  it("persists structuredRequirements into structured_requirements atomically with the status change", async () => {
    const db = new FakeStatusDb();
    seedRfq(db, "CREATED");
    const requirements = { quantity: 5000, product: "corrugated box" };

    await transitionRfq({
      client: db,
      rfqId: RFQ_ID,
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
      structuredRequirements: requirements,
    });

    const row = db.getRow("rfqs", RFQ_ID);
    assert.equal(row?.status, "PROCESSING");
    assert.deepEqual(row?.structured_requirements, requirements);
  });

  it("leaves structured_requirements untouched when the param is omitted (undefined)", async () => {
    const db = new FakeStatusDb();
    db.seed("rfqs", { id: RFQ_ID, status: "CREATED", structured_requirements: { pre: "existing" } });

    await transitionRfq({
      client: db,
      rfqId: RFQ_ID,
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
      // structuredRequirements intentionally omitted
    });

    const row = db.getRow("rfqs", RFQ_ID);
    assert.equal(row?.status, "PROCESSING");
    assert.deepEqual(row?.structured_requirements, { pre: "existing" });
  });

  it("writes an explicit null when structuredRequirements is null (distinct from omitting it)", async () => {
    const db = new FakeStatusDb();
    db.seed("rfqs", { id: RFQ_ID, status: "CREATED", structured_requirements: { pre: "existing" } });

    await transitionRfq({
      client: db,
      rfqId: RFQ_ID,
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
      structuredRequirements: null,
    });

    assert.equal(db.getRow("rfqs", RFQ_ID)?.structured_requirements, null);
  });

  it("does not write structuredRequirements when the underlying transition is stale/rejected", async () => {
    const db = new FakeStatusDb();
    seedRfq(db, "PROCESSING"); // already past CREATED

    await assert.rejects(
      () =>
        transitionRfq({
          client: db,
          rfqId: RFQ_ID,
          from: "CREATED", // stale belief
          to: "PROCESSING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
          structuredRequirements: { quantity: 1, product: "mailer" },
        }),
      StaleTransitionError,
    );

    assert.equal(db.getRow("rfqs", RFQ_ID)?.structured_requirements, undefined);
  });
});

describe("transitionRfq: database error propagation", () => {
  it("throws TransitionPersistenceError when the update itself fails", async () => {
    const db = new FakeStatusDb({ forcedErrors: { rfqs: "connection reset" } });
    seedRfq(db, "CREATED");

    await assert.rejects(
      () =>
        transitionRfq({
          client: db,
          rfqId: RFQ_ID,
          from: "CREATED",
          to: "PROCESSING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      TransitionPersistenceError,
    );
  });

  it("throws AuditWriteError when the status update commits but the audit insert fails (and does not roll back the status)", async () => {
    const db = new FakeStatusDb({ forcedErrors: { audit_events: "insert rejected" } });
    seedRfq(db, "CREATED");

    await assert.rejects(
      () =>
        transitionRfq({
          client: db,
          rfqId: RFQ_ID,
          from: "CREATED",
          to: "PROCESSING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      AuditWriteError,
    );

    assert.equal(db.getRow("rfqs", RFQ_ID)?.status, "PROCESSING");
  });
});

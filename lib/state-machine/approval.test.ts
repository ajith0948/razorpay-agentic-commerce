import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { APPROVAL_TRANSITIONS, transitionApproval } from "./approval.ts";
import { APPROVAL_STATUSES, type ApprovalStatus } from "./types.ts";
import { FakeStatusDb } from "./test-support.ts";
import {
  AuditWriteError,
  InvalidTransitionError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "./errors.ts";

const MERCHANT_ID = "merchant-1";
const APPROVAL_ID = "approval-1";

function seedApproval(db: FakeStatusDb, status: ApprovalStatus) {
  db.seed("approvals", { id: APPROVAL_ID, status, approved_by: null, approved_at: null });
}

/** Mirrors approval.ts's private approvalEventType() -- see that file's doc comment. */
function expectedEventType(to: ApprovalStatus): string {
  if (to === "APPROVED") return "APPROVAL_GRANTED";
  return "APPROVAL_STATUS_CHANGED";
}

describe("transitionApproval: valid edges", () => {
  for (const from of APPROVAL_STATUSES) {
    for (const to of APPROVAL_TRANSITIONS[from]) {
      it(`allows ${from} -> ${to} and writes a ${expectedEventType(to)} audit event`, async () => {
        const db = new FakeStatusDb();
        seedApproval(db, from);

        await transitionApproval({
          client: db,
          approvalId: APPROVAL_ID,
          from,
          to,
          merchantId: MERCHANT_ID,
          actorType: "HUMAN_MERCHANT",
          approvedBy: "merchant-user-1",
        });

        assert.equal(db.getRow("approvals", APPROVAL_ID)?.status, to);

        const events = [...db.tableMap("audit_events").values()];
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, expectedEventType(to));
      });
    }
  }
});

describe("transitionApproval: approved_by/approved_at are stamped on both outcomes", () => {
  it("stamps approved_by and approved_at on PENDING -> APPROVED", async () => {
    const db = new FakeStatusDb();
    seedApproval(db, "PENDING");

    await transitionApproval({
      client: db,
      approvalId: APPROVAL_ID,
      from: "PENDING",
      to: "APPROVED",
      merchantId: MERCHANT_ID,
      actorType: "HUMAN_MERCHANT",
      approvedBy: "merchant-user-1",
    });

    const row = db.getRow("approvals", APPROVAL_ID);
    assert.equal(row?.approved_by, "merchant-user-1");
    assert.equal(typeof row?.approved_at, "string");
  });

  it("also stamps approved_by and approved_at on PENDING -> REJECTED, so a rejection still records who/when decided it", async () => {
    const db = new FakeStatusDb();
    seedApproval(db, "PENDING");

    await transitionApproval({
      client: db,
      approvalId: APPROVAL_ID,
      from: "PENDING",
      to: "REJECTED",
      merchantId: MERCHANT_ID,
      actorType: "HUMAN_MERCHANT",
      approvedBy: "merchant-user-1",
    });

    const row = db.getRow("approvals", APPROVAL_ID);
    assert.equal(row?.status, "REJECTED");
    assert.equal(row?.approved_by, "merchant-user-1");
    assert.equal(typeof row?.approved_at, "string");
  });
});

describe("transitionApproval: a resolved approval cannot be changed again", () => {
  for (const terminal of ["APPROVED", "REJECTED"] as const) {
    it(`rejects every transition out of terminal state ${terminal}`, async () => {
      const db = new FakeStatusDb();
      seedApproval(db, terminal);

      for (const to of APPROVAL_STATUSES) {
        if (to === terminal) continue;
        await assert.rejects(
          () =>
            transitionApproval({
              client: db,
              approvalId: APPROVAL_ID,
              from: terminal,
              to,
              merchantId: MERCHANT_ID,
              actorType: "HUMAN_MERCHANT",
            }),
          InvalidTransitionError,
        );
      }
    });
  }
});

describe("transitionApproval: stale/concurrent updates", () => {
  it("throws StaleTransitionError when the row's real status no longer matches `from`", async () => {
    const db = new FakeStatusDb();
    seedApproval(db, "APPROVED");

    try {
      await transitionApproval({
        client: db,
        approvalId: APPROVAL_ID,
        from: "PENDING", // stale belief; row is actually APPROVED
        to: "APPROVED",
        merchantId: MERCHANT_ID,
        actorType: "HUMAN_MERCHANT",
      });
      assert.fail("expected transitionApproval to reject");
    } catch (err) {
      assert.ok(err instanceof StaleTransitionError);
      assert.equal(err.table, "approvals");
      assert.equal(err.id, APPROVAL_ID);
    }
  });

  it("throws StaleTransitionError when the row does not exist at all", async () => {
    const db = new FakeStatusDb();
    await assert.rejects(
      () =>
        transitionApproval({
          client: db,
          approvalId: "does-not-exist",
          from: "PENDING",
          to: "APPROVED",
          merchantId: MERCHANT_ID,
          actorType: "HUMAN_MERCHANT",
        }),
      StaleTransitionError,
    );
  });
});

describe("transitionApproval: database error propagation", () => {
  it("throws TransitionPersistenceError when the update itself fails", async () => {
    const db = new FakeStatusDb({ forcedErrors: { approvals: "connection reset" } });
    seedApproval(db, "PENDING");

    await assert.rejects(
      () =>
        transitionApproval({
          client: db,
          approvalId: APPROVAL_ID,
          from: "PENDING",
          to: "APPROVED",
          merchantId: MERCHANT_ID,
          actorType: "HUMAN_MERCHANT",
        }),
      TransitionPersistenceError,
    );
  });

  it("throws AuditWriteError when the audit insert fails (status is not rolled back)", async () => {
    const db = new FakeStatusDb({ forcedErrors: { audit_events: "insert rejected" } });
    seedApproval(db, "PENDING");

    await assert.rejects(
      () =>
        transitionApproval({
          client: db,
          approvalId: APPROVAL_ID,
          from: "PENDING",
          to: "APPROVED",
          merchantId: MERCHANT_ID,
          actorType: "HUMAN_MERCHANT",
        }),
      AuditWriteError,
    );

    assert.equal(db.getRow("approvals", APPROVAL_ID)?.status, "APPROVED");
  });
});

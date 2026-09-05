import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AGENT_SESSION_TRANSITIONS, transitionAgentSession } from "./agent-session.ts";
import { AGENT_SESSION_STATUSES, type AgentSessionStatus } from "./types.ts";
import { FakeStatusDb } from "./test-support.ts";
import {
  AuditWriteError,
  InvalidTransitionError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "./errors.ts";

const MERCHANT_ID = "merchant-1";
const SESSION_ID = "session-1";

function seedSession(db: FakeStatusDb, status: AgentSessionStatus) {
  db.seed("agent_sessions", { id: SESSION_ID, status, ended_at: null });
}

describe("transitionAgentSession: valid edges", () => {
  for (const from of AGENT_SESSION_STATUSES) {
    for (const to of AGENT_SESSION_TRANSITIONS[from]) {
      it(`allows ${from} -> ${to}, stamps ended_at, and writes an AGENT_SESSION_STATUS_CHANGED audit event`, async () => {
        const db = new FakeStatusDb();
        seedSession(db, from);

        await transitionAgentSession({
          client: db,
          sessionId: SESSION_ID,
          from,
          to,
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        });

        const row = db.getRow("agent_sessions", SESSION_ID);
        assert.equal(row?.status, to);
        assert.equal(typeof row?.ended_at, "string");

        const events = [...db.tableMap("audit_events").values()];
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, "AGENT_SESSION_STATUS_CHANGED");
        assert.equal(events[0].agent_session_id, SESSION_ID);
      });
    }
  }
});

describe("transitionAgentSession: a completed/failed/cancelled session cannot return to RUNNING", () => {
  for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
    it(`rejects ${terminal} -> RUNNING specifically`, async () => {
      const db = new FakeStatusDb();
      seedSession(db, terminal);

      await assert.rejects(
        () =>
          transitionAgentSession({
            client: db,
            sessionId: SESSION_ID,
            from: terminal,
            to: "RUNNING",
            merchantId: MERCHANT_ID,
            actorType: "SYSTEM",
          }),
        InvalidTransitionError,
      );
    });

    it(`rejects every transition out of terminal state ${terminal}`, async () => {
      const db = new FakeStatusDb();
      seedSession(db, terminal);

      for (const to of AGENT_SESSION_STATUSES) {
        if (to === terminal) continue;
        await assert.rejects(
          () =>
            transitionAgentSession({
              client: db,
              sessionId: SESSION_ID,
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

describe("transitionAgentSession: stale/concurrent updates", () => {
  it("throws StaleTransitionError when the row's real status no longer matches `from`", async () => {
    const db = new FakeStatusDb();
    seedSession(db, "COMPLETED");

    await assert.rejects(
      () =>
        transitionAgentSession({
          client: db,
          sessionId: SESSION_ID,
          from: "RUNNING", // stale belief; row is actually COMPLETED
          to: "COMPLETED",
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
        transitionAgentSession({
          client: db,
          sessionId: "does-not-exist",
          from: "RUNNING",
          to: "COMPLETED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });
});

describe("transitionAgentSession: database error propagation", () => {
  it("throws TransitionPersistenceError when the update itself fails", async () => {
    const db = new FakeStatusDb({ forcedErrors: { agent_sessions: "connection reset" } });
    seedSession(db, "RUNNING");

    await assert.rejects(
      () =>
        transitionAgentSession({
          client: db,
          sessionId: SESSION_ID,
          from: "RUNNING",
          to: "COMPLETED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      TransitionPersistenceError,
    );
  });

  it("throws AuditWriteError when the audit insert fails (status is not rolled back)", async () => {
    const db = new FakeStatusDb({ forcedErrors: { audit_events: "insert rejected" } });
    seedSession(db, "RUNNING");

    await assert.rejects(
      () =>
        transitionAgentSession({
          client: db,
          sessionId: SESSION_ID,
          from: "RUNNING",
          to: "COMPLETED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      AuditWriteError,
    );

    assert.equal(db.getRow("agent_sessions", SESSION_ID)?.status, "COMPLETED");
  });
});

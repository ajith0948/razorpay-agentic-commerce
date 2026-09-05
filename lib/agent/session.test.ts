import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAgentSessionApplication } from "./session.ts";
import type { AgentSessionDbClient, AgentSessionRow, NewAgentSessionRow, RfqRefRow } from "./db.ts";
import { toAgentSessionDbClient } from "./supabase-agent-session-db.ts";
import {
  AgentSessionNotFoundError,
  AgentSessionPersistenceError,
  AgentSessionRfqNotFoundError,
  AgentSessionValidationError,
} from "./errors.ts";
import type { PostgrestResult } from "../state-machine/index.ts";
import { createStateRuntime } from "../runtime/index.ts";
import { FakeStatusDb } from "../state-machine/test-support.ts";
import { InvalidTransitionError, StaleTransitionError } from "../state-machine/errors.ts";

const MERCHANT_ID = "merchant-1";
const BUYER_ID = "buyer-1";
const RFQ_ID = "rfq-1";

/**
 * Self-contained in-memory fake of AgentSessionDbClient -- same spirit as
 * lib/approval/application.test.ts's FakeApprovalDb.
 */
class FakeAgentSessionDb implements AgentSessionDbClient {
  private readonly sessions = new Map<string, AgentSessionRow>();
  private readonly rfqs = new Map<string, RfqRefRow>();
  private nextId = 1;
  insertError: { message: string } | null = null;
  selectError: { message: string } | null = null;
  rfqSelectError: { message: string } | null = null;

  seedSession(row: AgentSessionRow): void {
    this.sessions.set(row.id, row);
  }

  seedRfq(row: RfqRefRow): void {
    this.rfqs.set(row.id, row);
  }

  insertAgentSession(row: NewAgentSessionRow): PromiseLike<PostgrestResult<AgentSessionRow>> {
    if (this.insertError) {
      return Promise.resolve({ data: null, error: this.insertError });
    }
    const stored: AgentSessionRow = {
      id: `session-${this.nextId++}`,
      merchant_id: row.merchant_id,
      buyer_id: row.buyer_id,
      rfq_id: row.rfq_id,
      session_type: row.session_type,
      status: row.status,
      started_at: new Date().toISOString(),
      ended_at: null,
    };
    this.sessions.set(stored.id, stored);
    return Promise.resolve({ data: stored, error: null });
  }

  getAgentSessionById(id: string): PromiseLike<PostgrestResult<AgentSessionRow>> {
    if (this.selectError) {
      return Promise.resolve({ data: null, error: this.selectError });
    }
    return Promise.resolve({ data: this.sessions.get(id) ?? null, error: null });
  }

  getRfqRef(rfqId: string): PromiseLike<PostgrestResult<RfqRefRow>> {
    if (this.rfqSelectError) {
      return Promise.resolve({ data: null, error: this.rfqSelectError });
    }
    return Promise.resolve({ data: this.rfqs.get(rfqId) ?? null, error: null });
  }
}

/**
 * Adapts a FakeStatusDb's own "agent_sessions" table to AgentSessionDbClient
 * -- mirrors lib/approval/application.test.ts's approvalDbFromStatusDb().
 * Used only by the transitionSession lifecycle tests below, which never call
 * createSession(), so the creation/rfq-ref methods are unreachable stubs.
 */
function agentSessionDbFromStatusDb(statusDb: FakeStatusDb): AgentSessionDbClient {
  return {
    insertAgentSession: () => {
      throw new Error("agentSessionDbFromStatusDb: insertAgentSession() should not be called by lifecycle tests");
    },
    getAgentSessionById: (id) => {
      const row = statusDb.getRow("agent_sessions", id);
      return Promise.resolve({ data: (row ?? null) as unknown as AgentSessionRow | null, error: null });
    },
    getRfqRef: () => {
      throw new Error("agentSessionDbFromStatusDb: getRfqRef() should not be called by lifecycle tests");
    },
  };
}

function makeApp(db: AgentSessionDbClient = new FakeAgentSessionDb(), statusDb: FakeStatusDb = new FakeStatusDb()) {
  const runtime = createStateRuntime(statusDb);
  return { app: createAgentSessionApplication({ db, runtime }) };
}

const VALID_INPUT = { rfqId: RFQ_ID, sessionType: "SELLER_AGENT" as const };

function seedRfq(db: FakeAgentSessionDb, overrides: Partial<RfqRefRow> = {}): void {
  db.seedRfq({ id: RFQ_ID, merchant_id: MERCHANT_ID, buyer_id: BUYER_ID, ...overrides });
}

describe("createSession", () => {
  it("creates a valid AgentSession, deriving merchantId/buyerId from the referenced Rfq", async () => {
    const db = new FakeAgentSessionDb();
    seedRfq(db);
    const { app } = makeApp(db);

    const session = await app.createSession(VALID_INPUT);

    assert.equal(session.rfqId, RFQ_ID);
    assert.equal(session.merchantId, MERCHANT_ID);
    assert.equal(session.buyerId, BUYER_ID);
    assert.equal(session.sessionType, "SELLER_AGENT");
    assert.equal(typeof session.id, "string");
    assert.equal(typeof session.startedAt, "string");
  });

  it("establishes RUNNING as the initial state, without the caller supplying it", async () => {
    const db = new FakeAgentSessionDb();
    seedRfq(db);
    const { app } = makeApp(db);

    const session = await app.createSession(VALID_INPUT);
    assert.equal(session.status, "RUNNING");
    assert.equal(session.endedAt, null);
  });

  it("accepts BUYER_AGENT as the other valid sessionType", async () => {
    const db = new FakeAgentSessionDb();
    seedRfq(db);
    const { app } = makeApp(db);

    const session = await app.createSession({ rfqId: RFQ_ID, sessionType: "BUYER_AGENT" });
    assert.equal(session.sessionType, "BUYER_AGENT");
  });

  it("does not accept a caller-supplied merchantId/buyerId -- both always come from the Rfq", async () => {
    const db = new FakeAgentSessionDb();
    seedRfq(db, { merchant_id: "merchant-real", buyer_id: "buyer-real" });
    const { app } = makeApp(db);

    const session = await app.createSession({
      rfqId: RFQ_ID,
      sessionType: "SELLER_AGENT",
      // @ts-expect-error -- merchantId is intentionally not part of CreateAgentSessionInput
      merchantId: "merchant-spoofed",
    });

    assert.equal(session.merchantId, "merchant-real");
    assert.equal(session.buyerId, "buyer-real");
  });

  it("rejects a missing rfqId with AgentSessionValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(
      () => app.createSession({ rfqId: "", sessionType: "SELLER_AGENT" }),
      AgentSessionValidationError,
    );
  });

  it("rejects an invalid sessionType with AgentSessionValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(
      () =>
        app.createSession({
          rfqId: RFQ_ID,
          // @ts-expect-error -- deliberately invalid, to prove runtime validation catches what TS would also reject
          sessionType: "NOT_A_REAL_TYPE",
        }),
      AgentSessionValidationError,
    );
  });

  it("rejects creation against a nonexistent Rfq with AgentSessionRfqNotFoundError", async () => {
    const { app } = makeApp(new FakeAgentSessionDb());
    await assert.rejects(() => app.createSession(VALID_INPUT), AgentSessionRfqNotFoundError);
  });

  it("surfaces an Rfq-lookup database failure as AgentSessionPersistenceError", async () => {
    const db = new FakeAgentSessionDb();
    db.rfqSelectError = { message: "connection reset" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createSession(VALID_INPUT), AgentSessionPersistenceError);
  });

  it("surfaces an insert failure as AgentSessionPersistenceError", async () => {
    const db = new FakeAgentSessionDb();
    seedRfq(db);
    db.insertError = { message: "duplicate key value violates unique constraint" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createSession(VALID_INPUT), AgentSessionPersistenceError);
  });
});

describe("getSession", () => {
  it("returns an existing AgentSession", async () => {
    const db = new FakeAgentSessionDb();
    db.seedSession({
      id: "session-1",
      merchant_id: MERCHANT_ID,
      buyer_id: BUYER_ID,
      rfq_id: RFQ_ID,
      session_type: "SELLER_AGENT",
      status: "RUNNING",
      started_at: new Date().toISOString(),
      ended_at: null,
    });
    const { app } = makeApp(db);

    const session = await app.getSession("session-1");
    assert.equal(session.id, "session-1");
  });

  it("throws AgentSessionNotFoundError (not a null return) for a missing id", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.getSession("does-not-exist"), AgentSessionNotFoundError);
  });

  it("surfaces a database failure as AgentSessionPersistenceError", async () => {
    const db = new FakeAgentSessionDb();
    db.selectError = { message: "timeout" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.getSession("session-1"), AgentSessionPersistenceError);
  });
});

describe("transitionSession", () => {
  it("allows RUNNING -> COMPLETED", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("agent_sessions", { id: "session-1", status: "RUNNING", ended_at: null });
    const { app } = makeApp(agentSessionDbFromStatusDb(statusDb), statusDb);

    const session = await app.transitionSession({
      sessionId: "session-1",
      from: "RUNNING",
      to: "COMPLETED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(session.status, "COMPLETED");
  });

  it("allows RUNNING -> FAILED", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("agent_sessions", { id: "session-1", status: "RUNNING", ended_at: null });
    const { app } = makeApp(agentSessionDbFromStatusDb(statusDb), statusDb);

    const session = await app.transitionSession({
      sessionId: "session-1",
      from: "RUNNING",
      to: "FAILED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(session.status, "FAILED");
  });

  it("allows RUNNING -> CANCELLED", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("agent_sessions", { id: "session-1", status: "RUNNING", ended_at: null });
    const { app } = makeApp(agentSessionDbFromStatusDb(statusDb), statusDb);

    const session = await app.transitionSession({
      sessionId: "session-1",
      from: "RUNNING",
      to: "CANCELLED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(session.status, "CANCELLED");
  });

  it("rejects COMPLETED -> RUNNING -- a finished session is terminal", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("agent_sessions", { id: "session-1", status: "COMPLETED", ended_at: new Date().toISOString() });
    const { app } = makeApp(agentSessionDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionSession({
          sessionId: "session-1",
          from: "COMPLETED",
          to: "RUNNING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      InvalidTransitionError,
    );
  });

  it("rejects a stale from-status with StaleTransitionError", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("agent_sessions", { id: "session-1", status: "COMPLETED", ended_at: new Date().toISOString() });
    const { app } = makeApp(agentSessionDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionSession({
          sessionId: "session-1",
          from: "RUNNING",
          to: "COMPLETED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });
});

describe("boundary integrity: the Agent Session application layer never mutates status directly", () => {
  it("the Supabase-backed AgentSessionDbClient exposes only the three intended operations -- no update/patch operation exists to call", () => {
    const client = toAgentSessionDbClient({} as unknown as SupabaseClient);
    assert.deepEqual(Object.keys(client).sort(), ["getAgentSessionById", "getRfqRef", "insertAgentSession"]);
    assert.equal(Reflect.has(client, "update"), false);
  });

  it("createSession() and read paths never touch lib/runtime's StatusDbClient at all", async () => {
    const statusDb = new FakeStatusDb();
    const db = new FakeAgentSessionDb();
    seedRfq(db);
    const { app } = makeApp(db, statusDb);

    await app.createSession(VALID_INPUT);
    assert.equal(statusDb.calls.length, 0);

    await assert.rejects(() => app.getSession("does-not-exist"));
    assert.equal(statusDb.calls.length, 0);
  });

  it("transitionSession() touches only the table(s) an Agent Session transition legitimately owns", async () => {
    const statusDb = new FakeStatusDb({ allowedTables: ["agent_sessions", "audit_events"] });
    statusDb.seed("agent_sessions", { id: "session-1", status: "RUNNING", ended_at: null });
    const { app } = makeApp(agentSessionDbFromStatusDb(statusDb), statusDb);

    await app.transitionSession({
      sessionId: "session-1",
      from: "RUNNING",
      to: "COMPLETED",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(statusDb.getRow("agent_sessions", "session-1")?.status, "COMPLETED");
  });
});

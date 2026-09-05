import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createRfqApplication } from "./application.ts";
import type { RfqDbClient, RfqRow, NewRfqRow } from "./db.ts";
import { toRfqDbClient } from "./supabase-rfq-db.ts";
import {
  RfqNotFoundError,
  RfqPersistenceError,
  RfqRequirementsParsingError,
  RfqValidationError,
} from "./errors.ts";
import {
  createDeterministicRequirementsParser,
  type RequirementsParser,
} from "./requirements-parser.ts";
import type { PostgrestResult } from "../state-machine/index.ts";
import { createStateRuntime } from "../runtime/index.ts";
import { FakeStatusDb } from "../state-machine/test-support.ts";
import {
  InvalidTransitionError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "../state-machine/errors.ts";

const MERCHANT_ID = "merchant-1";
const BUYER_ID = "buyer-1";

/**
 * Self-contained in-memory fake of RfqDbClient -- same spirit as
 * lib/state-machine/test-support.ts's FakeStatusDb but scoped to this
 * layer's own two-operation port. Used for creation/retrieval tests, which
 * never touch lib/runtime.
 */
class FakeRfqDb implements RfqDbClient {
  private readonly rows = new Map<string, RfqRow>();
  private nextId = 1;
  insertError: { message: string } | null = null;
  selectError: { message: string } | null = null;

  seed(row: RfqRow): void {
    this.rows.set(row.id, row);
  }

  insertRfq(row: NewRfqRow): PromiseLike<PostgrestResult<RfqRow>> {
    if (this.insertError) {
      return Promise.resolve({ data: null, error: this.insertError });
    }
    const now = new Date().toISOString();
    const stored: RfqRow = {
      id: `rfq-${this.nextId++}`,
      merchant_id: row.merchant_id,
      buyer_id: row.buyer_id,
      raw_request: row.raw_request,
      structured_requirements: null,
      status: "CREATED",
      created_at: now,
      updated_at: now,
      expires_at: row.expires_at ?? null,
    };
    this.rows.set(stored.id, stored);
    return Promise.resolve({ data: stored, error: null });
  }

  getRfqById(id: string): PromiseLike<PostgrestResult<RfqRow>> {
    if (this.selectError) {
      return Promise.resolve({ data: null, error: this.selectError });
    }
    return Promise.resolve({ data: this.rows.get(id) ?? null, error: null });
  }
}

/**
 * Adapts a FakeStatusDb's own "rfqs" table to RfqDbClient -- mirrors how
 * createSupabaseRfqApplication() shares one real Supabase client between
 * toRfqDbClient() and toStatusDbClient(). Used only by the lifecycle tests
 * below, so the RFQ layer's read of a row and lib/runtime's write to that
 * same row hit the same underlying store, exactly like production wiring
 * (two independent fakes would let the two sides silently drift apart).
 */
function rfqDbFromStatusDb(statusDb: FakeStatusDb): RfqDbClient {
  return {
    insertRfq: (row) => {
      const now = new Date().toISOString();
      const stored = statusDb.seed("rfqs", {
        merchant_id: row.merchant_id,
        buyer_id: row.buyer_id,
        raw_request: row.raw_request,
        structured_requirements: null,
        status: "CREATED",
        created_at: now,
        updated_at: now,
        expires_at: row.expires_at ?? null,
      });
      // FakeStatusDb stores rows as the generic FakeRow shape (Record<string,
      // unknown>); bridging that to RfqRow is this test-only adapter's whole job.
      return Promise.resolve({ data: stored as unknown as RfqRow, error: null });
    },
    getRfqById: (id) => {
      const row = statusDb.getRow("rfqs", id);
      return Promise.resolve({ data: (row ?? null) as unknown as RfqRow | null, error: null });
    },
  };
}

function makeApp(
  db: RfqDbClient = new FakeRfqDb(),
  statusDb: FakeStatusDb = new FakeStatusDb(),
  parser: RequirementsParser = createDeterministicRequirementsParser(),
) {
  const runtime = createStateRuntime(statusDb);
  return { app: createRfqApplication({ db, runtime, parser }) };
}

describe("createRfq", () => {
  it("creates a valid RFQ and returns the mapped domain object", async () => {
    const { app } = makeApp();
    const rfq = await app.createRfq({
      merchantId: MERCHANT_ID,
      buyerId: BUYER_ID,
      rawRequest: "Need 500 custom boxes",
    });

    assert.equal(rfq.merchantId, MERCHANT_ID);
    assert.equal(rfq.buyerId, BUYER_ID);
    assert.equal(rfq.rawRequest, "Need 500 custom boxes");
    assert.equal(typeof rfq.id, "string");
    assert.equal(typeof rfq.createdAt, "string");
    assert.equal(rfq.structuredRequirements, null);
  });

  it("establishes CREATED as the initial state, without the caller supplying it", async () => {
    const { app } = makeApp();
    const rfq = await app.createRfq({ merchantId: MERCHANT_ID, buyerId: BUYER_ID, rawRequest: "x" });
    assert.equal(rfq.status, "CREATED");
  });

  it("rejects a missing required field with RfqValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(
      () => app.createRfq({ merchantId: "", buyerId: BUYER_ID, rawRequest: "x" }),
      RfqValidationError,
    );
  });

  it("rejects invalid input (an expiresAt already in the past) with RfqValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(
      () =>
        app.createRfq({
          merchantId: MERCHANT_ID,
          buyerId: BUYER_ID,
          rawRequest: "x",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      RfqValidationError,
    );
  });

  it("surfaces a database failure as RfqPersistenceError", async () => {
    const db = new FakeRfqDb();
    db.insertError = { message: "connection reset" };
    const { app } = makeApp(db);

    await assert.rejects(
      () => app.createRfq({ merchantId: MERCHANT_ID, buyerId: BUYER_ID, rawRequest: "x" }),
      RfqPersistenceError,
    );
  });
});

describe("getRfqById", () => {
  it("returns an existing RFQ", async () => {
    const db = new FakeRfqDb();
    db.seed({
      id: "rfq-1",
      merchant_id: MERCHANT_ID,
      buyer_id: BUYER_ID,
      raw_request: "x",
      structured_requirements: null,
      status: "CREATED",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
    });
    const { app } = makeApp(db);

    const rfq = await app.getRfqById("rfq-1");
    assert.equal(rfq.id, "rfq-1");
    assert.equal(rfq.status, "CREATED");
  });

  it("throws RfqNotFoundError, not a null return, for a missing RFQ", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.getRfqById("does-not-exist"), RfqNotFoundError);
  });

  it("surfaces a database failure as RfqPersistenceError, distinct from RfqNotFoundError", async () => {
    const db = new FakeRfqDb();
    db.selectError = { message: "timeout" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.getRfqById("rfq-1"), RfqPersistenceError);
  });
});

describe("transitionRfqStatus", () => {
  it("performs a valid transition through lib/runtime and returns the fresh RFQ", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("rfqs", { id: "rfq-1", status: "CREATED" });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    const rfq = await app.transitionRfqStatus({
      rfqId: "rfq-1",
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(rfq.id, "rfq-1");
    assert.equal(rfq.status, "PROCESSING");
    assert.equal(statusDb.getRow("rfqs", "rfq-1")?.status, "PROCESSING");
  });

  it("rejects a disallowed edge with InvalidTransitionError, propagated unchanged from lib/state-machine", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("rfqs", { id: "rfq-1", status: "ACCEPTED" });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionRfqStatus({
          rfqId: "rfq-1",
          from: "ACCEPTED",
          to: "QUOTED",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      InvalidTransitionError,
    );
  });

  it("rejects a stale/concurrent transition with StaleTransitionError", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("rfqs", { id: "rfq-1", status: "PROCESSING" });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionRfqStatus({
          rfqId: "rfq-1",
          from: "CREATED", // stale belief; the row is actually PROCESSING
          to: "PROCESSING",
          merchantId: MERCHANT_ID,
          actorType: "SYSTEM",
        }),
      StaleTransitionError,
    );
  });

  it("goes through lib/runtime: a valid transition produces an audit event", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("rfqs", { id: "rfq-1", status: "CREATED" });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    await app.transitionRfqStatus({
      rfqId: "rfq-1",
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(statusDb.tableMap("audit_events").size, 1);
  });
});

describe("boundary integrity: the RFQ application layer never mutates status directly", () => {
  it("the Supabase-backed RfqDbClient exposes only insertRfq/getRfqById -- no update/patch operation exists to call", () => {
    const client = toRfqDbClient({} as unknown as SupabaseClient);
    assert.deepEqual(Object.keys(client).sort(), ["getRfqById", "insertRfq"]);
    assert.equal(Reflect.has(client, "update"), false);
  });

  it("createRfq() and getRfqById() never touch lib/runtime's StatusDbClient at all", async () => {
    const statusDb = new FakeStatusDb();
    const { app } = makeApp(new FakeRfqDb(), statusDb);

    await app.createRfq({ merchantId: MERCHANT_ID, buyerId: BUYER_ID, rawRequest: "x" });
    assert.equal(statusDb.calls.length, 0);

    await assert.rejects(() => app.getRfqById("does-not-exist"));
    assert.equal(statusDb.calls.length, 0);
  });

  it("transitionRfqStatus() touches only the table(s) an RFQ transition legitimately owns", async () => {
    const statusDb = new FakeStatusDb({ allowedTables: ["rfqs", "audit_events"] });
    statusDb.seed("rfqs", { id: "rfq-1", status: "CREATED" });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    // Would throw synchronously (surfacing as a rejection) if this layer, or
    // anything it calls, reached into a table beyond what an RFQ transition
    // legitimately owns.
    await app.transitionRfqStatus({
      rfqId: "rfq-1",
      from: "CREATED",
      to: "PROCESSING",
      merchantId: MERCHANT_ID,
      actorType: "SYSTEM",
    });

    assert.equal(statusDb.getRow("rfqs", "rfq-1")?.status, "PROCESSING");
  });
});

describe("processRfqRequirements", () => {
  it("parses raw_request, transitions CREATED -> PROCESSING through lib/runtime, and persists structured_requirements atomically", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("rfqs", {
      id: "rfq-1",
      merchant_id: MERCHANT_ID,
      buyer_id: BUYER_ID,
      raw_request:
        "I need 5,000 5-ply boxes, 18x12x10, with a 2-color logo, deliver to " +
        "Chennai within 10 days, budget ₹120,000.",
      structured_requirements: null,
      status: "CREATED",
    });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    const rfq = await app.processRfqRequirements("rfq-1");

    assert.equal(rfq.id, "rfq-1");
    assert.equal(rfq.status, "PROCESSING");
    assert.deepEqual(rfq.structuredRequirements, {
      quantity: 5000,
      product: "corrugated box",
      dimensions: "18x12x10",
      material: "5-ply",
      printing: "2-color",
      destination: "Chennai",
      deadline: "10 days",
      budget: 120000,
    });

    // Persisted state matches the returned domain object -- not just an
    // in-memory result that was never actually written.
    const row = statusDb.getRow("rfqs", "rfq-1");
    assert.equal(row?.status, "PROCESSING");
    assert.deepEqual(row?.structured_requirements, rfq.structuredRequirements);
    assert.equal(statusDb.tableMap("audit_events").size, 1);
  });

  it("propagates RfqRequirementsParsingError and leaves the RFQ in CREATED with structured_requirements still null", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("rfqs", {
      id: "rfq-1",
      merchant_id: MERCHANT_ID,
      buyer_id: BUYER_ID,
      raw_request: "Please call me back about our account.",
      structured_requirements: null,
      status: "CREATED",
    });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(() => app.processRfqRequirements("rfq-1"), RfqRequirementsParsingError);

    // Never left claiming success while nothing was persisted: status and
    // structured_requirements are both exactly as they were before the call.
    const row = statusDb.getRow("rfqs", "rfq-1");
    assert.equal(row?.status, "CREATED");
    assert.equal(row?.structured_requirements, null);
    assert.equal(statusDb.tableMap("audit_events").size, 0);
  });

  it("throws RfqNotFoundError for a missing RFQ", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.processRfqRequirements("does-not-exist"), RfqNotFoundError);
  });

  it("throws StaleTransitionError when the RFQ is not currently CREATED", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("rfqs", {
      id: "rfq-1",
      merchant_id: MERCHANT_ID,
      buyer_id: BUYER_ID,
      raw_request: "Need 500 mailers",
      structured_requirements: null,
      status: "PROCESSING", // already past CREATED
    });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(() => app.processRfqRequirements("rfq-1"), StaleTransitionError);
  });

  it("propagates TransitionPersistenceError (reused from lib/state-machine, not swallowed) when the status update fails", async () => {
    const statusDb = new FakeStatusDb({ forcedErrors: { rfqs: "connection reset" } });
    statusDb.seed("rfqs", {
      id: "rfq-1",
      merchant_id: MERCHANT_ID,
      buyer_id: BUYER_ID,
      raw_request: "Need 500 mailers",
      structured_requirements: null,
      status: "CREATED",
    });
    const { app } = makeApp(rfqDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(() => app.processRfqRequirements("rfq-1"), TransitionPersistenceError);
  });
});

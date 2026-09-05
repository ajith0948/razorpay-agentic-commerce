import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createQuoteApplication } from "./application.ts";
import type { MerchantPolicyRow, QuoteDbClient, QuoteRow, RfqRefRow } from "./db.ts";
import { toQuoteDbClient } from "./supabase-quote-db.ts";
import {
  QuoteNotFoundError,
  QuotePersistenceError,
  QuotePolicyLimitError,
  QuoteRfqNotFoundError,
  QuoteRfqStateError,
  QuoteValidationError,
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
const BUYER_ID = "buyer-1";
const RFQ_ID = "rfq-1";

/**
 * Self-contained in-memory fake of QuoteDbClient -- same spirit as
 * lib/rfq/application.test.ts's FakeRfqDb, extended with the RFQ-ref and
 * merchant-policy reads this layer's createQuote() also needs. Used for
 * creation/retrieval tests, which never touch lib/runtime.
 */
class FakeQuoteDb implements QuoteDbClient {
  private readonly quotes = new Map<string, QuoteRow>();
  private readonly rfqs = new Map<string, RfqRefRow>();
  private readonly policies = new Map<string, MerchantPolicyRow>();
  private nextId = 1;
  insertError: { message: string } | null = null;
  selectError: { message: string } | null = null;
  rfqSelectError: { message: string } | null = null;
  policySelectError: { message: string } | null = null;

  seedQuote(row: QuoteRow): void {
    this.quotes.set(row.id, row);
  }

  seedRfq(row: RfqRefRow): void {
    this.rfqs.set(row.id, row);
  }

  seedPolicy(merchantId: string, row: MerchantPolicyRow): void {
    this.policies.set(merchantId, row);
  }

  insertQuote(row: {
    rfq_id: string;
    merchant_id: string;
    buyer_id: string;
    total_amount: number;
    currency: string;
    discount_percent: number;
    delivery_days: number;
    delivery_location: string;
    valid_until?: string | null;
  }): PromiseLike<PostgrestResult<QuoteRow>> {
    if (this.insertError) {
      return Promise.resolve({ data: null, error: this.insertError });
    }
    const now = new Date().toISOString();
    const stored: QuoteRow = {
      id: `quote-${this.nextId++}`,
      rfq_id: row.rfq_id,
      merchant_id: row.merchant_id,
      buyer_id: row.buyer_id,
      total_amount: row.total_amount,
      currency: row.currency,
      discount_percent: row.discount_percent,
      delivery_days: row.delivery_days,
      delivery_location: row.delivery_location,
      valid_until: row.valid_until ?? null,
      status: "DRAFT",
      created_at: now,
      updated_at: now,
    };
    this.quotes.set(stored.id, stored);
    return Promise.resolve({ data: stored, error: null });
  }

  getQuoteById(id: string): PromiseLike<PostgrestResult<QuoteRow>> {
    if (this.selectError) {
      return Promise.resolve({ data: null, error: this.selectError });
    }
    return Promise.resolve({ data: this.quotes.get(id) ?? null, error: null });
  }

  getRfqRef(rfqId: string): PromiseLike<PostgrestResult<RfqRefRow>> {
    if (this.rfqSelectError) {
      return Promise.resolve({ data: null, error: this.rfqSelectError });
    }
    return Promise.resolve({ data: this.rfqs.get(rfqId) ?? null, error: null });
  }

  getActiveMerchantPolicy(merchantId: string): PromiseLike<PostgrestResult<MerchantPolicyRow>> {
    if (this.policySelectError) {
      return Promise.resolve({ data: null, error: this.policySelectError });
    }
    return Promise.resolve({ data: this.policies.get(merchantId) ?? null, error: null });
  }
}

/**
 * Adapts a FakeStatusDb's own "quotes" table to QuoteDbClient -- mirrors
 * lib/rfq/application.test.ts's rfqDbFromStatusDb(). Used only by the
 * lifecycle tests below, which never call createQuote(), so the
 * RFQ-ref/policy methods are unreachable stubs.
 */
function quoteDbFromStatusDb(statusDb: FakeStatusDb): QuoteDbClient {
  return {
    insertQuote: () => {
      throw new Error("quoteDbFromStatusDb: insertQuote() should not be called by lifecycle tests");
    },
    getQuoteById: (id) => {
      const row = statusDb.getRow("quotes", id);
      return Promise.resolve({ data: (row ?? null) as unknown as QuoteRow | null, error: null });
    },
    getRfqRef: () => {
      throw new Error("quoteDbFromStatusDb: getRfqRef() should not be called by lifecycle tests");
    },
    getActiveMerchantPolicy: () => {
      throw new Error(
        "quoteDbFromStatusDb: getActiveMerchantPolicy() should not be called by lifecycle tests",
      );
    },
  };
}

function makeApp(db: QuoteDbClient = new FakeQuoteDb(), statusDb: FakeStatusDb = new FakeStatusDb()) {
  const runtime = createStateRuntime(statusDb);
  return { app: createQuoteApplication({ db, runtime }) };
}

const VALID_INPUT = {
  rfqId: RFQ_ID,
  totalAmount: 114000,
  currency: "INR",
  deliveryDays: 10,
  deliveryLocation: "Chennai",
};

function seedEligibleRfq(db: FakeQuoteDb, overrides: Partial<RfqRefRow> = {}): void {
  db.seedRfq({
    id: RFQ_ID,
    merchant_id: MERCHANT_ID,
    buyer_id: BUYER_ID,
    status: "PROCESSING",
    ...overrides,
  });
}

describe("createQuote", () => {
  it("creates a valid Quote, deriving merchantId/buyerId from the referenced RFQ", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    const quote = await app.createQuote(VALID_INPUT);

    assert.equal(quote.rfqId, RFQ_ID);
    assert.equal(quote.merchantId, MERCHANT_ID);
    assert.equal(quote.buyerId, BUYER_ID);
    assert.equal(quote.totalAmount, 114000);
    assert.equal(quote.currency, "INR");
    assert.equal(quote.deliveryDays, 10);
    assert.equal(quote.deliveryLocation, "Chennai");
    assert.equal(typeof quote.id, "string");
    assert.equal(typeof quote.createdAt, "string");
  });

  it("establishes DRAFT as the initial state, without the caller supplying it", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    const quote = await app.createQuote(VALID_INPUT);
    assert.equal(quote.status, "DRAFT");
  });

  it("defaults discountPercent to 0 when omitted", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    const quote = await app.createQuote(VALID_INPUT);
    assert.equal(quote.discountPercent, 0);
  });

  it("persists an explicit discountPercent and validUntil", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const quote = await app.createQuote({ ...VALID_INPUT, discountPercent: 3, validUntil });

    assert.equal(quote.discountPercent, 3);
    assert.equal(quote.validUntil, validUntil);
  });

  it("rejects a missing rfqId with QuoteValidationError", async () => {
    const { app } = makeApp();
    await assert.rejects(
      () => app.createQuote({ ...VALID_INPUT, rfqId: "" }),
      QuoteValidationError,
    );
  });

  it("rejects a negative totalAmount with QuoteValidationError", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    await assert.rejects(
      () => app.createQuote({ ...VALID_INPUT, totalAmount: -1 }),
      QuoteValidationError,
    );
  });

  it("rejects a discountPercent outside 0-100 with QuoteValidationError", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    await assert.rejects(
      () => app.createQuote({ ...VALID_INPUT, discountPercent: 101 }),
      QuoteValidationError,
    );
  });

  it("rejects a negative deliveryDays with QuoteValidationError", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    await assert.rejects(
      () => app.createQuote({ ...VALID_INPUT, deliveryDays: -1 }),
      QuoteValidationError,
    );
  });

  it("rejects a validUntil already in the past with QuoteValidationError", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    await assert.rejects(
      () =>
        app.createQuote({
          ...VALID_INPUT,
          validUntil: new Date(Date.now() - 60_000).toISOString(),
        }),
      QuoteValidationError,
    );
  });

  it("rejects creation against a nonexistent RFQ with QuoteRfqNotFoundError", async () => {
    const { app } = makeApp(new FakeQuoteDb());
    await assert.rejects(
      () => app.createQuote({ ...VALID_INPUT, rfqId: "does-not-exist" }),
      QuoteRfqNotFoundError,
    );
  });

  it("rejects creation against an RFQ in a terminal state with QuoteRfqStateError", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db, { status: "ACCEPTED" });
    const { app } = makeApp(db);

    await assert.rejects(() => app.createQuote(VALID_INPUT), QuoteRfqStateError);
  });

  for (const status of ["REJECTED", "EXPIRED", "CANCELLED", "FAILED"] as const) {
    it(`rejects creation against an RFQ in terminal state ${status} with QuoteRfqStateError`, async () => {
      const db = new FakeQuoteDb();
      seedEligibleRfq(db, { status });
      const { app } = makeApp(db);

      await assert.rejects(() => app.createQuote(VALID_INPUT), QuoteRfqStateError);
    });
  }

  for (const status of ["PROCESSING", "QUOTED", "NEGOTIATING"] as const) {
    it(`allows creation against a non-terminal RFQ in state ${status}`, async () => {
      const db = new FakeQuoteDb();
      seedEligibleRfq(db, { status });
      const { app } = makeApp(db);

      const quote = await app.createQuote(VALID_INPUT);
      assert.equal(quote.rfqId, RFQ_ID);
    });
  }

  it("rejects a discount exceeding the merchant's active policy limit with QuotePolicyLimitError", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    db.seedPolicy(MERCHANT_ID, { max_discount_percent: 5 });
    const { app } = makeApp(db);

    await assert.rejects(
      () => app.createQuote({ ...VALID_INPUT, discountPercent: 15 }),
      QuotePolicyLimitError,
    );
  });

  it("allows a discount within the merchant's active policy limit", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    db.seedPolicy(MERCHANT_ID, { max_discount_percent: 5 });
    const { app } = makeApp(db);

    const quote = await app.createQuote({ ...VALID_INPUT, discountPercent: 5 });
    assert.equal(quote.discountPercent, 5);
  });

  it("skips the policy check (does not reject) when the merchant has no active policy configured", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    const quote = await app.createQuote({ ...VALID_INPUT, discountPercent: 50 });
    assert.equal(quote.discountPercent, 50);
  });

  it("surfaces an RFQ-lookup database failure as QuotePersistenceError", async () => {
    const db = new FakeQuoteDb();
    db.rfqSelectError = { message: "connection reset" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createQuote(VALID_INPUT), QuotePersistenceError);
  });

  it("surfaces an insert failure as QuotePersistenceError", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    db.insertError = { message: "duplicate key value violates unique constraint" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.createQuote(VALID_INPUT), QuotePersistenceError);
  });
});

describe("getQuoteById", () => {
  it("returns an existing Quote", async () => {
    const db = new FakeQuoteDb();
    db.seedQuote({
      id: "quote-1",
      rfq_id: RFQ_ID,
      merchant_id: MERCHANT_ID,
      buyer_id: BUYER_ID,
      total_amount: 114000,
      currency: "INR",
      discount_percent: 0,
      delivery_days: 10,
      delivery_location: "Chennai",
      valid_until: null,
      status: "DRAFT",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const { app } = makeApp(db);

    const quote = await app.getQuoteById("quote-1");
    assert.equal(quote.id, "quote-1");
    assert.equal(quote.status, "DRAFT");
  });

  it("throws QuoteNotFoundError, not a null return, for a missing Quote", async () => {
    const { app } = makeApp();
    await assert.rejects(() => app.getQuoteById("does-not-exist"), QuoteNotFoundError);
  });

  it("surfaces a database failure as QuotePersistenceError, distinct from QuoteNotFoundError", async () => {
    const db = new FakeQuoteDb();
    db.selectError = { message: "timeout" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.getQuoteById("quote-1"), QuotePersistenceError);
  });
});

describe("relationship: RFQ <-> Quote", () => {
  it("the created Quote references the RFQ it was created against", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    const quote = await app.createQuote(VALID_INPUT);
    assert.equal(quote.rfqId, RFQ_ID);
  });

  it("the schema's lack of a unique constraint on rfq_id allows multiple Quotes per RFQ", async () => {
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db);

    const first = await app.createQuote(VALID_INPUT);
    const second = await app.createQuote({ ...VALID_INPUT, totalAmount: 120000 });

    assert.notEqual(first.id, second.id);
    assert.equal(first.rfqId, RFQ_ID);
    assert.equal(second.rfqId, RFQ_ID);
  });
});

describe("transitionQuoteStatus", () => {
  it("performs a valid transition through lib/runtime and returns the fresh Quote", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("quotes", { id: "quote-1", status: "DRAFT" });
    const { app } = makeApp(quoteDbFromStatusDb(statusDb), statusDb);

    const quote = await app.transitionQuoteStatus({
      quoteId: "quote-1",
      from: "DRAFT",
      to: "SENT",
      merchantId: MERCHANT_ID,
      actorType: "SELLER_AGENT",
    });

    assert.equal(quote.id, "quote-1");
    assert.equal(quote.status, "SENT");
    assert.equal(statusDb.getRow("quotes", "quote-1")?.status, "SENT");
  });

  it("rejects a disallowed edge with InvalidTransitionError, propagated unchanged from lib/state-machine", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("quotes", { id: "quote-1", status: "DRAFT" });
    const { app } = makeApp(quoteDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionQuoteStatus({
          quoteId: "quote-1",
          from: "DRAFT",
          to: "ACCEPTED", // skips SENT/NEGOTIATING; no such edge
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        }),
      InvalidTransitionError,
    );
  });

  it("rejects a stale/concurrent transition with StaleTransitionError", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("quotes", { id: "quote-1", status: "SENT" });
    const { app } = makeApp(quoteDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionQuoteStatus({
          quoteId: "quote-1",
          from: "DRAFT", // stale belief; the row is actually SENT
          to: "SENT",
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        }),
      StaleTransitionError,
    );
  });

  it("goes through lib/runtime: a valid transition produces an audit event", async () => {
    const statusDb = new FakeStatusDb();
    statusDb.seed("quotes", { id: "quote-1", status: "DRAFT" });
    const { app } = makeApp(quoteDbFromStatusDb(statusDb), statusDb);

    await app.transitionQuoteStatus({
      quoteId: "quote-1",
      from: "DRAFT",
      to: "SENT",
      merchantId: MERCHANT_ID,
      actorType: "SELLER_AGENT",
    });

    assert.equal(statusDb.tableMap("audit_events").size, 1);
  });

  it("propagates TransitionPersistenceError (reused from lib/state-machine, not swallowed) when the status update fails", async () => {
    const statusDb = new FakeStatusDb({ forcedErrors: { quotes: "connection reset" } });
    statusDb.seed("quotes", { id: "quote-1", status: "DRAFT" });
    const { app } = makeApp(quoteDbFromStatusDb(statusDb), statusDb);

    await assert.rejects(
      () =>
        app.transitionQuoteStatus({
          quoteId: "quote-1",
          from: "DRAFT",
          to: "SENT",
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        }),
      TransitionPersistenceError,
    );
  });
});

describe("boundary integrity: the Quote application layer never mutates status directly", () => {
  it("the Supabase-backed QuoteDbClient exposes only the four intended operations -- no update/patch operation exists to call", () => {
    const client = toQuoteDbClient({} as unknown as SupabaseClient);
    assert.deepEqual(Object.keys(client).sort(), [
      "getActiveMerchantPolicy",
      "getQuoteById",
      "getRfqRef",
      "insertQuote",
    ]);
    assert.equal(Reflect.has(client, "update"), false);
  });

  it("createQuote() and getQuoteById() never touch lib/runtime's StatusDbClient at all", async () => {
    const statusDb = new FakeStatusDb();
    const db = new FakeQuoteDb();
    seedEligibleRfq(db);
    const { app } = makeApp(db, statusDb);

    await app.createQuote(VALID_INPUT);
    assert.equal(statusDb.calls.length, 0);

    await assert.rejects(() => app.getQuoteById("does-not-exist"));
    assert.equal(statusDb.calls.length, 0);
  });

  it("transitionQuoteStatus() touches only the table(s) a Quote transition legitimately owns", async () => {
    const statusDb = new FakeStatusDb({ allowedTables: ["quotes", "audit_events"] });
    statusDb.seed("quotes", { id: "quote-1", status: "DRAFT" });
    const { app } = makeApp(quoteDbFromStatusDb(statusDb), statusDb);

    // Would throw synchronously (surfacing as a rejection) if this layer, or
    // anything it calls, reached into a table beyond what a Quote transition
    // legitimately owns.
    await app.transitionQuoteStatus({
      quoteId: "quote-1",
      from: "DRAFT",
      to: "SENT",
      merchantId: MERCHANT_ID,
      actorType: "SELLER_AGENT",
    });

    assert.equal(statusDb.getRow("quotes", "quote-1")?.status, "SENT");
  });
});

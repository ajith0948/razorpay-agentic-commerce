/**
 * Tests for GET /api/quotes/:id (app/api/quotes/[id]/route.ts). This file
 * deliberately lives here, one level up from the route it tests, rather
 * than alongside it as app/api/quotes/[id]/route.test.ts: Node's built-in
 * test runner (`node --test <path>`) treats a `[...]` segment in a
 * CLI-supplied file path as a glob character class, not a literal directory
 * name -- confirmed empirically (`node --test "app/api/quotes/[id]/route.test.ts"`
 * silently matches zero files, no error). Next.js's own routing convention
 * requires the `[id]` directory name for the dynamic segment, so the route
 * file itself cannot move; only where its test lives is negotiable. Module
 * resolution (the `from "./[id]/route.ts"` import below) is unaffected --
 * only the test runner's own CLI argument parsing treats brackets specially.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleGetQuote } from "./[id]/route.ts";
import type { QuoteApplication } from "../../../lib/quote/index.ts";
import { QuoteNotFoundError, QuotePersistenceError } from "../../../lib/quote/index.ts";
import type { Quote } from "../../../lib/quote/types.ts";

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: "quote-1",
    rfqId: "rfq-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    totalAmount: 114000,
    currency: "INR",
    discountPercent: 0,
    deliveryDays: 10,
    deliveryLocation: "Chennai",
    validUntil: null,
    status: "DRAFT",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Fake QuoteApplication -- this route only ever calls getQuoteById().
 * createQuote()/transitionQuoteStatus() throw if reached, so a test would
 * fail loudly if GET ever started performing a write.
 */
class FakeQuoteApplication implements QuoteApplication {
  getQuoteByIdCalls: string[] = [];
  getQuoteByIdImpl: (quoteId: string) => Promise<Quote> = async (quoteId) =>
    makeQuote({ id: quoteId });

  async createQuote(): Promise<Quote> {
    throw new Error("FakeQuoteApplication: createQuote() should not be called by GET /api/quotes/:id");
  }

  async getQuoteById(quoteId: string): Promise<Quote> {
    this.getQuoteByIdCalls.push(quoteId);
    return this.getQuoteByIdImpl(quoteId);
  }

  async transitionQuoteStatus(): Promise<Quote> {
    throw new Error(
      "FakeQuoteApplication: transitionQuoteStatus() should not be called by GET /api/quotes/:id",
    );
  }
}

describe("GET /api/quotes/:id: success", () => {
  it("returns 200 with the Quote for a valid id", async () => {
    const app = new FakeQuoteApplication();
    const res = await handleGetQuote(app, "quote-42");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.quote.id, "quote-42");
  });

  it("delegates to getQuoteById() with exactly the given id, and calls it exactly once", async () => {
    const app = new FakeQuoteApplication();
    await handleGetQuote(app, "quote-42");

    assert.deepEqual(app.getQuoteByIdCalls, ["quote-42"]);
  });
});

describe("GET /api/quotes/:id: not found (404)", () => {
  it("maps QuoteNotFoundError to 404 QUOTE_NOT_FOUND", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async () => {
      throw new QuoteNotFoundError("quote-42");
    };

    const res = await handleGetQuote(app, "quote-42");

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "QUOTE_NOT_FOUND");
  });
});

describe("GET /api/quotes/:id: persistence failure (500, no internal leak)", () => {
  it("maps a QuotePersistenceError to 500 without leaking its message", async () => {
    const app = new FakeQuoteApplication();
    const secret = "duplicate key value violates unique constraint";
    app.getQuoteByIdImpl = async () => {
      throw new QuotePersistenceError("select", secret);
    };

    const res = await handleGetQuote(app, "quote-42");

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });

  it("maps a wholly unexpected thrown value to 500 INTERNAL_ERROR", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async () => {
      throw new Error("something truly unanticipated");
    };

    const res = await handleGetQuote(app, "quote-42");

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes("something truly unanticipated"));
  });
});

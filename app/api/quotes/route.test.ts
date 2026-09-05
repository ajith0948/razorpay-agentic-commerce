import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleCreateQuote } from "./route.ts";
import type { QuoteApplication } from "../../../lib/quote/index.ts";
import {
  QuoteNotFoundError,
  QuotePersistenceError,
  QuotePolicyLimitError,
  QuoteRfqNotFoundError,
  QuoteRfqStateError,
  QuoteValidationError,
} from "../../../lib/quote/index.ts";
import type { CreateQuoteInput, Quote } from "../../../lib/quote/types.ts";

const RFQ_ID = "rfq-1";
const MERCHANT_ID = "merchant-1";
const BUYER_ID = "buyer-1";

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: "quote-1",
    rfqId: RFQ_ID,
    merchantId: MERCHANT_ID,
    buyerId: BUYER_ID,
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
 * Fake QuoteApplication -- this route only ever calls createQuote().
 * getQuoteById()/transitionQuoteStatus() throw if reached, so a test would
 * fail loudly (not silently pass) if the route ever started calling a
 * method it has no business calling -- in particular, this proves POST
 * /api/quotes never dispatches a lifecycle transition merely because a
 * Quote was created (Step 3/Step 12's integration-boundary requirement).
 */
class FakeQuoteApplication implements QuoteApplication {
  createQuoteCalls: CreateQuoteInput[] = [];
  createQuoteImpl: (input: CreateQuoteInput) => Promise<Quote> = async (input) =>
    makeQuote({
      rfqId: input.rfqId,
      totalAmount: input.totalAmount,
      currency: input.currency,
      discountPercent: input.discountPercent ?? 0,
      deliveryDays: input.deliveryDays,
      deliveryLocation: input.deliveryLocation,
      validUntil: input.validUntil ?? null,
    });

  async createQuote(input: CreateQuoteInput): Promise<Quote> {
    this.createQuoteCalls.push(input);
    return this.createQuoteImpl(input);
  }

  async getQuoteById(): Promise<Quote> {
    throw new Error("FakeQuoteApplication: getQuoteById() should not be called by POST /api/quotes");
  }

  async transitionQuoteStatus(): Promise<Quote> {
    throw new Error(
      "FakeQuoteApplication: transitionQuoteStatus() should not be called by POST /api/quotes " +
        "-- creating a Quote must never itself dispatch a lifecycle transition.",
    );
  }
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/quotes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(rawBody: string): Request {
  return new Request("http://localhost/api/quotes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

const VALID_BODY = {
  rfqId: RFQ_ID,
  totalAmount: 114000,
  currency: "INR",
  deliveryDays: 10,
  deliveryLocation: "Chennai",
};

describe("POST /api/quotes: success", () => {
  it("returns 201 with the created Quote", async () => {
    const app = new FakeQuoteApplication();
    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.quote.rfqId, RFQ_ID);
    assert.equal(payload.quote.totalAmount, 114000);
  });

  it("calls createQuote() exactly once, with the parsed request body", async () => {
    const app = new FakeQuoteApplication();
    await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(app.createQuoteCalls.length, 1);
    assert.equal(app.createQuoteCalls[0].rfqId, RFQ_ID);
    assert.equal(app.createQuoteCalls[0].totalAmount, 114000);
    assert.equal(app.createQuoteCalls[0].currency, "INR");
    assert.equal(app.createQuoteCalls[0].deliveryDays, 10);
    assert.equal(app.createQuoteCalls[0].deliveryLocation, "Chennai");
  });

  it("passes discountPercent/validUntil through when provided, and omits them when absent", async () => {
    const app = new FakeQuoteApplication();
    await handleCreateQuote(
      app,
      jsonRequest({ ...VALID_BODY, discountPercent: 3, validUntil: "2027-01-01T00:00:00.000Z" }),
    );
    assert.equal(app.createQuoteCalls[0].discountPercent, 3);
    assert.equal(app.createQuoteCalls[0].validUntil, "2027-01-01T00:00:00.000Z");

    const app2 = new FakeQuoteApplication();
    await handleCreateQuote(app2, jsonRequest(VALID_BODY));
    assert.equal(app2.createQuoteCalls[0].discountPercent, undefined);
    assert.equal(app2.createQuoteCalls[0].validUntil, undefined);
  });

  it("creates a Quote with status DRAFT, and never calls transitionQuoteStatus()", async () => {
    const app = new FakeQuoteApplication();
    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    const payload = await res.json();
    assert.equal(payload.quote.status, "DRAFT");
    // FakeQuoteApplication.transitionQuoteStatus() throws if called at all;
    // reaching this line without a thrown error already proves it wasn't.
  });
});

describe("POST /api/quotes: malformed/invalid request body (400)", () => {
  it("rejects a body that is not valid JSON, without calling createQuote()", async () => {
    const app = new FakeQuoteApplication();
    const res = await handleCreateQuote(app, rawRequest("{not valid json"));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createQuoteCalls.length, 0);
  });

  it("rejects a body missing a required field", async () => {
    const app = new FakeQuoteApplication();
    const res = await handleCreateQuote(app, jsonRequest({ rfqId: RFQ_ID, currency: "INR" }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.ok(payload.error.details.some((d: { field: string }) => d.field === "totalAmount"));
    assert.equal(app.createQuoteCalls.length, 0);
  });

  it("rejects a field with the wrong JSON type", async () => {
    const app = new FakeQuoteApplication();
    const res = await handleCreateQuote(app, jsonRequest({ ...VALID_BODY, totalAmount: "114000" }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createQuoteCalls.length, 0);
  });

  it("does not reject an empty-string field at the HTTP-shape layer (that is layer 2's job)", async () => {
    const app = new FakeQuoteApplication();
    const res = await handleCreateQuote(app, jsonRequest({ ...VALID_BODY, rfqId: "" }));
    assert.notEqual(res.status, 400);
    assert.equal(app.createQuoteCalls.length, 1);
  });
});

describe("POST /api/quotes: business validation failure (400)", () => {
  it("maps QuoteValidationError to 400 VALIDATION_ERROR", async () => {
    const app = new FakeQuoteApplication();
    app.createQuoteImpl = async () => {
      throw new QuoteValidationError("totalAmount", "must not be negative");
    };

    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "VALIDATION_ERROR");
    assert.equal(payload.error.field, "totalAmount");
  });
});

describe("POST /api/quotes: RFQ reference failures", () => {
  it("maps QuoteRfqNotFoundError to 404 RFQ_NOT_FOUND", async () => {
    const app = new FakeQuoteApplication();
    app.createQuoteImpl = async () => {
      throw new QuoteRfqNotFoundError(RFQ_ID);
    };

    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "RFQ_NOT_FOUND");
    assert.equal(payload.error.rfqId, RFQ_ID);
  });

  it("maps QuoteRfqStateError (terminal RFQ) to 422 RFQ_NOT_ELIGIBLE_FOR_QUOTE", async () => {
    const app = new FakeQuoteApplication();
    app.createQuoteImpl = async () => {
      throw new QuoteRfqStateError(RFQ_ID, "ACCEPTED");
    };

    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 422);
    const payload = await res.json();
    assert.equal(payload.error.code, "RFQ_NOT_ELIGIBLE_FOR_QUOTE");
    assert.equal(payload.error.rfqId, RFQ_ID);
    assert.equal(payload.error.rfqStatus, "ACCEPTED");
  });
});

describe("POST /api/quotes: policy violation (422)", () => {
  it("maps QuotePolicyLimitError to 422 QUOTE_POLICY_LIMIT_EXCEEDED", async () => {
    const app = new FakeQuoteApplication();
    app.createQuoteImpl = async () => {
      throw new QuotePolicyLimitError(15, 5);
    };

    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 422);
    const payload = await res.json();
    assert.equal(payload.error.code, "QUOTE_POLICY_LIMIT_EXCEEDED");
    assert.equal(payload.error.discountPercent, 15);
    assert.equal(payload.error.maxDiscountPercent, 5);
  });
});

describe("POST /api/quotes: persistence/unexpected failures (500, no internal leak)", () => {
  it("maps a QuotePersistenceError to 500 without leaking its message", async () => {
    const app = new FakeQuoteApplication();
    const secret = "connection to db-primary-7.internal:5432 refused";
    app.createQuoteImpl = async () => {
      throw new QuotePersistenceError("insert", secret);
    };

    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });

  it("maps a wholly unexpected thrown value to 500 INTERNAL_ERROR", async () => {
    const app = new FakeQuoteApplication();
    app.createQuoteImpl = async () => {
      throw new Error("something truly unanticipated");
    };

    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes("something truly unanticipated"));
  });

  it("never reaches QuoteNotFoundError from this route in practice, but maps it safely if thrown", async () => {
    // Defensive: createQuote()'s contract does not throw this today, but a
    // generic mapper shared with GET /api/quotes/:id must still handle it
    // correctly rather than falling through to a misleading 500.
    const app = new FakeQuoteApplication();
    app.createQuoteImpl = async () => {
      throw new QuoteNotFoundError("quote-1");
    };

    const res = await handleCreateQuote(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "QUOTE_NOT_FOUND");
  });
});

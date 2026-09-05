/**
 * Tests for POST /api/quotes/:id/accept (app/api/quotes/[id]/accept/route.ts).
 * This file deliberately lives here, two directories up from the route it
 * tests, rather than alongside it -- same bracket-glob reasoning as
 * app/api/quotes/quote-id-route.test.ts's own header comment: Node's
 * built-in test runner treats a `[...]` segment in a CLI-supplied file path
 * as a glob character class, not a literal directory name.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleAcceptQuote } from "./[id]/accept/route.ts";
import type { QuoteApplication } from "../../../lib/quote/index.ts";
import type { TransitionQuoteStatusInput } from "../../../lib/quote/application.ts";
import {
  QuoteNotFoundError,
  QuotePersistenceError,
} from "../../../lib/quote/index.ts";
import { InvalidTransitionError } from "../../../lib/state-machine/index.ts";
import type { Quote } from "../../../lib/quote/types.ts";
import type { RfqApplication } from "../../../lib/rfq/index.ts";
import type { TransitionRfqStatusInput } from "../../../lib/rfq/application.ts";
import type { Rfq } from "../../../lib/rfq/types.ts";

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
    status: "NEGOTIATING",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRfq(overrides: Partial<Rfq> = {}): Rfq {
  return {
    id: "rfq-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    rawRequest: "test request",
    structuredRequirements: null,
    status: "QUOTED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}


/**
 * Fake QuoteApplication -- this route only ever calls getQuoteById() (to
 * discover the current status/merchantId/buyerId/rfqId) then
 * transitionQuoteStatus(). createQuote() throws if reached, so a test would
 * fail loudly if the route ever started creating a Quote.
 */
class FakeQuoteApplication implements QuoteApplication {
  getQuoteByIdCalls: string[] = [];
  getQuoteByIdImpl: (quoteId: string) => Promise<Quote> = async (quoteId) =>
    makeQuote({ id: quoteId });

  transitionQuoteStatusCalls: TransitionQuoteStatusInput[] = [];
  transitionQuoteStatusImpl: (params: TransitionQuoteStatusInput) => Promise<Quote> = async (
    params,
  ) => makeQuote({ id: params.quoteId, status: params.to });

  async createQuote(): Promise<Quote> {
    throw new Error(
      "FakeQuoteApplication: createQuote() should not be called by POST /api/quotes/:id/accept",
    );
  }

  async getQuoteById(quoteId: string): Promise<Quote> {
    this.getQuoteByIdCalls.push(quoteId);
    return this.getQuoteByIdImpl(quoteId);
  }

  async transitionQuoteStatus(params: TransitionQuoteStatusInput): Promise<Quote> {
    this.transitionQuoteStatusCalls.push(params);
    return this.transitionQuoteStatusImpl(params);
  }
}

class FakeRfqApplication implements RfqApplication {
  getRfqByIdCalls: string[] = [];
  getRfqByIdImpl: (rfqId: string) => Promise<Rfq> = async (rfqId) =>
    makeRfq({ id: rfqId });

  transitionRfqStatusCalls: TransitionRfqStatusInput[] = [];
  transitionRfqStatusImpl: (params: TransitionRfqStatusInput) => Promise<Rfq> = async (
    params,
  ) => makeRfq({ id: params.rfqId, status: params.to });

  async createRfq(): Promise<Rfq> {
    throw new Error("createRfq not implemented in fake");
  }

  async processRfqRequirements(rfqId: string): Promise<Rfq> {
    throw new Error("processRfqRequirements not implemented in fake");
  }

  async getRfqById(rfqId: string): Promise<Rfq> {
    this.getRfqByIdCalls.push(rfqId);
    return this.getRfqByIdImpl(rfqId);
  }

  async transitionRfqStatus(params: TransitionRfqStatusInput): Promise<Rfq> {
    this.transitionRfqStatusCalls.push(params);
    return this.transitionRfqStatusImpl(params);
  }
}

describe("POST /api/quotes/:id/accept: success", () => {
  it("returns 200 with the accepted Quote and transitions parent RFQ to ACCEPTED", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async (quoteId) => makeQuote({ id: quoteId, status: "SENT", rfqId: "rfq-42" });
    const rfqApp = new FakeRfqApplication();
    rfqApp.getRfqByIdImpl = async (rfqId) => makeRfq({ id: rfqId, status: "QUOTED", merchantId: "m1", buyerId: "b1" });
    
    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.quote.id, "quote-42");
    assert.equal(payload.quote.status, "ACCEPTED");

    assert.deepEqual(rfqApp.getRfqByIdCalls, ["rfq-42"]);
    assert.equal(rfqApp.transitionRfqStatusCalls.length, 1);
    assert.deepEqual(rfqApp.transitionRfqStatusCalls[0], {
      rfqId: "rfq-42",
      from: "QUOTED",
      to: "ACCEPTED",
      merchantId: "m1",
      buyerId: "b1",
      actorType: "BUYER",
    });
  });

  it("safely handles non-QUOTED/NEGOTIATING RFQ state by skipping transition", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async (quoteId) => makeQuote({ id: quoteId, status: "SENT", rfqId: "rfq-42" });
    const rfqApp = new FakeRfqApplication();
    rfqApp.getRfqByIdImpl = async (rfqId) => makeRfq({ id: rfqId, status: "ACCEPTED" });
    
    const res = await handleAcceptQuote(app, rfqApp, "quote-42");
    assert.equal(res.status, 200);
    assert.equal(rfqApp.transitionRfqStatusCalls.length, 0);
  });

  it("reads the current Quote, then transitions NEGOTIATING -> ACCEPTED as BUYER, deriving merchant/buyer/rfq from the read", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async (quoteId) =>
      makeQuote({
        id: quoteId,
        status: "NEGOTIATING",
        merchantId: "merchant-9",
        buyerId: "buyer-9",
        rfqId: "rfq-9",
      });
    const rfqApp = new FakeRfqApplication();
    rfqApp.getRfqByIdImpl = async (rfqId) => makeRfq({ id: rfqId, status: "NEGOTIATING", merchantId: "merchant-9", buyerId: "buyer-9" });

    await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.deepEqual(app.getQuoteByIdCalls, ["quote-42"]);
    assert.equal(app.transitionQuoteStatusCalls.length, 1);
    assert.deepEqual(app.transitionQuoteStatusCalls[0], {
      quoteId: "quote-42",
      from: "NEGOTIATING",
      to: "ACCEPTED",
      merchantId: "merchant-9",
      buyerId: "buyer-9",
      rfqId: "rfq-9",
      actorType: "BUYER",
    });

    assert.equal(rfqApp.transitionRfqStatusCalls.length, 1);
    assert.deepEqual(rfqApp.transitionRfqStatusCalls[0], {
      rfqId: "rfq-9",
      from: "NEGOTIATING",
      to: "ACCEPTED",
      merchantId: "merchant-9",
      buyerId: "buyer-9",
      actorType: "BUYER",
    });
  });
});

describe("POST /api/quotes/:id/accept: SENT -> ACCEPTED (normal agent-created-quote path)", () => {
  it("accepts a SENT quote and transitions the parent RFQ from QUOTED to ACCEPTED", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async (quoteId) => makeQuote({ id: quoteId, status: "SENT", rfqId: "rfq-1" });
    const rfqApp = new FakeRfqApplication();
    rfqApp.getRfqByIdImpl = async (rfqId) => makeRfq({ id: rfqId, status: "QUOTED" });

    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.quote.status, "ACCEPTED");
    assert.equal(app.transitionQuoteStatusCalls[0].from, "SENT");
    assert.equal(app.transitionQuoteStatusCalls[0].to, "ACCEPTED");
    assert.equal(rfqApp.transitionRfqStatusCalls.length, 1);
    assert.equal(rfqApp.transitionRfqStatusCalls[0].to, "ACCEPTED");
  });
});

describe("POST /api/quotes/:id/accept: idempotency (already ACCEPTED)", () => {
  it("returns 200 with the current quote if it is already ACCEPTED -- no duplicate transition or 409", async () => {
    const app = new FakeQuoteApplication();
    const alreadyAccepted = makeQuote({ id: "quote-42", status: "ACCEPTED" });
    app.getQuoteByIdImpl = async () => alreadyAccepted;
    const rfqApp = new FakeRfqApplication();

    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.quote.status, "ACCEPTED");
    // No transition attempted -- quote already in terminal state
    assert.equal(app.transitionQuoteStatusCalls.length, 0);
    // No RFQ lookup (short-circuited before reaching cascade)
    assert.equal(rfqApp.getRfqByIdCalls.length, 0);
  });
});

describe("POST /api/quotes/:id/accept: RFQ cascade failure is non-fatal", () => {
  it("returns 200 with the accepted quote even if the RFQ cascade throws StaleTransitionError", async () => {
    const { StaleTransitionError } = await import("../../../lib/state-machine/index.ts");

    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async (quoteId) => makeQuote({ id: quoteId, status: "SENT", rfqId: "rfq-1" });
    const rfqApp = new FakeRfqApplication();
    rfqApp.transitionRfqStatusImpl = async () => {
      throw new StaleTransitionError("rfqs", "rfq-1", "QUOTED", "ACCEPTED");
    };

    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    // Must be 200, not 409 -- the quote itself was accepted
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.quote.status, "ACCEPTED");
  });

  it("skips RFQ transition and returns 200 when RFQ is already ACCEPTED", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async (quoteId) => makeQuote({ id: quoteId, status: "SENT", rfqId: "rfq-1" });
    const rfqApp = new FakeRfqApplication();
    rfqApp.getRfqByIdImpl = async (rfqId) => makeRfq({ id: rfqId, status: "ACCEPTED" });

    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.equal(res.status, 200);
    // RFQ was already ACCEPTED -- no transition attempted
    assert.equal(rfqApp.transitionRfqStatusCalls.length, 0);
  });
});

describe("POST /api/quotes/:id/accept: invalid transition (409)", () => {
  it("maps InvalidTransitionError (DRAFT -> ACCEPTED) to 409 TRANSITION_CONFLICT", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async (quoteId) => makeQuote({ id: quoteId, status: "DRAFT" });
    app.transitionQuoteStatusImpl = async () => {
      throw new InvalidTransitionError("quote", "DRAFT", "ACCEPTED");
    };
    const rfqApp = new FakeRfqApplication();

    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.equal(payload.error.code, "TRANSITION_CONFLICT");
  });

  it("still rejects EXPIRED -> ACCEPTED with 409", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async (quoteId) => makeQuote({ id: quoteId, status: "EXPIRED" });
    app.transitionQuoteStatusImpl = async () => {
      throw new InvalidTransitionError("quote", "EXPIRED", "ACCEPTED");
    };
    const rfqApp = new FakeRfqApplication();

    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.equal(payload.error.code, "TRANSITION_CONFLICT");
  });
});

describe("POST /api/quotes/:id/accept: missing quote (404)", () => {
  it("maps QuoteNotFoundError to 404 QUOTE_NOT_FOUND and never attempts a transition", async () => {
    const app = new FakeQuoteApplication();
    app.getQuoteByIdImpl = async () => {
      throw new QuoteNotFoundError("quote-42");
    };
    const rfqApp = new FakeRfqApplication();

    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "QUOTE_NOT_FOUND");
    assert.equal(app.transitionQuoteStatusCalls.length, 0);
  });
});

describe("POST /api/quotes/:id/accept: application error mapping (500, no internal leak)", () => {
  it("maps a QuotePersistenceError to 500 without leaking its message", async () => {
    const app = new FakeQuoteApplication();
    const secret = "duplicate key value violates unique constraint";
    app.getQuoteByIdImpl = async () => {
      throw new QuotePersistenceError("select", secret);
    };
    const rfqApp = new FakeRfqApplication();

    const res = await handleAcceptQuote(app, rfqApp, "quote-42");

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });
});

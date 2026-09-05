import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleCreateRfq } from "./route.ts";
import type { RfqApplication } from "../../../lib/rfq/index.ts";
import {
  RfqNotFoundError,
  RfqPersistenceError,
  RfqRequirementsParsingError,
  RfqValidationError,
} from "../../../lib/rfq/index.ts";
import type { CreateRfqInput, Rfq } from "../../../lib/rfq/types.ts";
import { StaleTransitionError, TransitionPersistenceError } from "../../../lib/state-machine/index.ts";

const MERCHANT_ID = "merchant-1";
const BUYER_ID = "buyer-1";

function makeRfq(overrides: Partial<Rfq> = {}): Rfq {
  return {
    id: "rfq-1",
    merchantId: MERCHANT_ID,
    buyerId: BUYER_ID,
    rawRequest: "Need 500 mailers",
    structuredRequirements: null,
    status: "CREATED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

/**
 * Fake RfqApplication -- this route only ever calls createRfq() and
 * processRfqRequirements(); getRfqById()/transitionRfqStatus() throw if
 * reached, so a test would fail loudly (not silently pass) if the route
 * ever started calling a method it has no business calling.
 */
class FakeRfqApplication implements RfqApplication {
  createRfqCalls: CreateRfqInput[] = [];
  processRfqRequirementsCalls: string[] = [];
  createRfqImpl: (input: CreateRfqInput) => Promise<Rfq> = async (input) =>
    makeRfq({ merchantId: input.merchantId, buyerId: input.buyerId, rawRequest: input.rawRequest });
  processRfqRequirementsImpl: (rfqId: string) => Promise<Rfq> = async (rfqId) =>
    makeRfq({ id: rfqId, status: "PROCESSING", structuredRequirements: { quantity: 500, product: "mailer" } });

  async createRfq(input: CreateRfqInput): Promise<Rfq> {
    this.createRfqCalls.push(input);
    return this.createRfqImpl(input);
  }

  async getRfqById(): Promise<Rfq> {
    throw new Error("FakeRfqApplication: getRfqById() should not be called by POST /api/rfqs");
  }

  async transitionRfqStatus(): Promise<Rfq> {
    throw new Error("FakeRfqApplication: transitionRfqStatus() should not be called by POST /api/rfqs");
  }

  async processRfqRequirements(rfqId: string): Promise<Rfq> {
    this.processRfqRequirementsCalls.push(rfqId);
    return this.processRfqRequirementsImpl(rfqId);
  }
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/rfqs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(rawBody: string): Request {
  return new Request("http://localhost/api/rfqs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

const VALID_BODY = { merchantId: MERCHANT_ID, buyerId: BUYER_ID, rawRequest: "Need 500 mailers" };

describe("POST /api/rfqs: success", () => {
  it("returns 201 with the created and processed RFQ", async () => {
    const app = new FakeRfqApplication();
    const res = await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.rfq.id, "rfq-1");
    assert.equal(payload.rfq.status, "PROCESSING");
    assert.deepEqual(payload.rfq.structuredRequirements, { quantity: 500, product: "mailer" });
  });

  it("calls createRfq() with the request body, then processRfqRequirements() with the created id, in that order", async () => {
    const app = new FakeRfqApplication();
    app.createRfqImpl = async (input) => makeRfq({ id: "rfq-42", ...input });

    await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(app.createRfqCalls.length, 1);
    assert.equal(app.createRfqCalls[0].merchantId, MERCHANT_ID);
    assert.equal(app.createRfqCalls[0].buyerId, BUYER_ID);
    assert.equal(app.createRfqCalls[0].rawRequest, "Need 500 mailers");
    assert.deepEqual(app.processRfqRequirementsCalls, ["rfq-42"]);
  });

  it("passes expiresAt through when provided, and omits it (undefined) when absent", async () => {
    const app = new FakeRfqApplication();
    await handleCreateRfq(app, jsonRequest({ ...VALID_BODY, expiresAt: "2027-01-01T00:00:00.000Z" }));
    assert.equal(app.createRfqCalls[0].expiresAt, "2027-01-01T00:00:00.000Z");

    const app2 = new FakeRfqApplication();
    await handleCreateRfq(app2, jsonRequest(VALID_BODY));
    assert.equal(app2.createRfqCalls[0].expiresAt, undefined);
  });
});

describe("POST /api/rfqs: malformed/invalid request body (400)", () => {
  it("rejects a body that is not valid JSON, without calling createRfq()", async () => {
    const app = new FakeRfqApplication();
    const res = await handleCreateRfq(app, rawRequest("{not valid json"));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createRfqCalls.length, 0);
  });

  it("rejects a body missing a required field", async () => {
    const app = new FakeRfqApplication();
    const res = await handleCreateRfq(app, jsonRequest({ merchantId: MERCHANT_ID, buyerId: BUYER_ID }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.ok(payload.error.details.some((d: { field: string }) => d.field === "rawRequest"));
    assert.equal(app.createRfqCalls.length, 0);
  });

  it("rejects a field with the wrong JSON type", async () => {
    const app = new FakeRfqApplication();
    const res = await handleCreateRfq(app, jsonRequest({ ...VALID_BODY, merchantId: 12345 }));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_REQUEST_BODY");
    assert.equal(app.createRfqCalls.length, 0);
  });

  it("does not reject an empty-string field at the HTTP-shape layer (that is layer 2's job)", async () => {
    // Confirms the three validation layers stay non-overlapping: an empty
    // string is a well-typed JSON string, so Zod (layer 1) lets it through;
    // whether it is rejected is entirely up to whatever RfqApplication.
    // createRfq() (layer 2) does with it.
    const app = new FakeRfqApplication();
    const res = await handleCreateRfq(app, jsonRequest({ ...VALID_BODY, rawRequest: "" }));
    assert.notEqual(res.status, 400);
    assert.equal(app.createRfqCalls.length, 1);
  });
});

describe("POST /api/rfqs: business validation failure (400)", () => {
  it("maps RfqValidationError from createRfq() to 400 VALIDATION_ERROR, without calling processRfqRequirements()", async () => {
    const app = new FakeRfqApplication();
    app.createRfqImpl = async () => {
      throw new RfqValidationError("rawRequest", "is required");
    };

    const res = await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.error.code, "VALIDATION_ERROR");
    assert.equal(payload.error.field, "rawRequest");
    assert.equal(app.processRfqRequirementsCalls.length, 0);
  });
});

describe("POST /api/rfqs: requirements parsing failure (422)", () => {
  it("maps RfqRequirementsParsingError to 422 with the created rfqId and missingFields", async () => {
    const app = new FakeRfqApplication();
    app.createRfqImpl = async () => makeRfq({ id: "rfq-99" });
    app.processRfqRequirementsImpl = async () => {
      throw new RfqRequirementsParsingError(["quantity", "product"]);
    };

    const res = await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 422);
    const payload = await res.json();
    assert.equal(payload.error.code, "RFQ_REQUIREMENTS_INCOMPLETE");
    assert.equal(payload.error.rfqId, "rfq-99");
    assert.deepEqual(payload.error.missingFields, ["quantity", "product"]);
  });
});

describe("POST /api/rfqs: transition conflict (409)", () => {
  it("maps StaleTransitionError to 409 TRANSITION_CONFLICT", async () => {
    const app = new FakeRfqApplication();
    app.processRfqRequirementsImpl = async () => {
      throw new StaleTransitionError("rfqs", "rfq-1", "CREATED", "PROCESSING");
    };

    const res = await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.equal(payload.error.code, "TRANSITION_CONFLICT");
  });
});

describe("POST /api/rfqs: RFQ not found (404, defensive)", () => {
  it("maps RfqNotFoundError to 404 RFQ_NOT_FOUND", async () => {
    const app = new FakeRfqApplication();
    app.processRfqRequirementsImpl = async () => {
      throw new RfqNotFoundError("rfq-1");
    };

    const res = await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "RFQ_NOT_FOUND");
  });
});

describe("POST /api/rfqs: persistence/unexpected failures (500, no internal leak)", () => {
  it("maps a createRfq() persistence failure to 500 without calling processRfqRequirements()", async () => {
    const app = new FakeRfqApplication();
    const secret = "connection to db-primary-7.internal:5432 refused";
    app.createRfqImpl = async () => {
      throw new RfqPersistenceError("insert", secret);
    };

    const res = await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
    assert.equal(app.processRfqRequirementsCalls.length, 0);
  });

  it("maps a TransitionPersistenceError from processRfqRequirements() to 500 without leaking its message", async () => {
    const app = new FakeRfqApplication();
    const secret = "duplicate key value violates unique constraint";
    app.processRfqRequirementsImpl = async () => {
      throw new TransitionPersistenceError("rfqs", "rfq-1", secret);
    };

    const res = await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });

  it("maps a wholly unexpected thrown value to 500 INTERNAL_ERROR", async () => {
    const app = new FakeRfqApplication();
    app.createRfqImpl = async () => {
      throw new Error("something truly unanticipated");
    };

    const res = await handleCreateRfq(app, jsonRequest(VALID_BODY));

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes("something truly unanticipated"));
  });
});

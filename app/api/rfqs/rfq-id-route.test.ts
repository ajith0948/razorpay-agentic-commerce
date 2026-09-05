/**
 * Tests for GET /api/rfqs/:id (app/api/rfqs/[id]/route.ts). This file
 * deliberately lives here, one level up from the route it tests, rather than
 * alongside it as app/api/rfqs/[id]/route.test.ts -- same reasoning as
 * app/api/quotes/quote-id-route.test.ts's own header comment: Node's
 * built-in test runner treats a `[...]` segment in a CLI-supplied file path
 * as a glob character class, not a literal directory name.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleGetRfq } from "./[id]/route.ts";
import type { RfqApplication } from "../../../lib/rfq/index.ts";
import { RfqNotFoundError, RfqPersistenceError } from "../../../lib/rfq/index.ts";
import type { Rfq } from "../../../lib/rfq/types.ts";

function makeRfq(overrides: Partial<Rfq> = {}): Rfq {
  return {
    id: "rfq-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    rawRequest: "Need 500 boxes",
    structuredRequirements: { quantity: 500, product: "boxes" },
    status: "PROCESSING",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

/**
 * Fake RfqApplication -- this route only ever calls getRfqById().
 * createRfq()/transitionRfqStatus()/processRfqRequirements() throw if
 * reached, so a test would fail loudly if GET ever started performing a
 * write.
 */
class FakeRfqApplication implements RfqApplication {
  getRfqByIdCalls: string[] = [];
  getRfqByIdImpl: (rfqId: string) => Promise<Rfq> = async (rfqId) => makeRfq({ id: rfqId });

  async createRfq(): Promise<Rfq> {
    throw new Error("FakeRfqApplication: createRfq() should not be called by GET /api/rfqs/:id");
  }

  async getRfqById(rfqId: string): Promise<Rfq> {
    this.getRfqByIdCalls.push(rfqId);
    return this.getRfqByIdImpl(rfqId);
  }

  async transitionRfqStatus(): Promise<Rfq> {
    throw new Error(
      "FakeRfqApplication: transitionRfqStatus() should not be called by GET /api/rfqs/:id",
    );
  }

  async processRfqRequirements(): Promise<Rfq> {
    throw new Error(
      "FakeRfqApplication: processRfqRequirements() should not be called by GET /api/rfqs/:id",
    );
  }
}

describe("GET /api/rfqs/:id: success", () => {
  it("returns 200 with the Rfq for a valid id", async () => {
    const app = new FakeRfqApplication();
    const res = await handleGetRfq(app, "rfq-42");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);

    const payload = await res.json();
    assert.equal(payload.rfq.id, "rfq-42");
  });

  it("delegates to getRfqById() with exactly the given id, and calls it exactly once", async () => {
    const app = new FakeRfqApplication();
    await handleGetRfq(app, "rfq-42");

    assert.deepEqual(app.getRfqByIdCalls, ["rfq-42"]);
  });
});

describe("GET /api/rfqs/:id: not found (404)", () => {
  it("maps RfqNotFoundError to 404 RFQ_NOT_FOUND", async () => {
    const app = new FakeRfqApplication();
    app.getRfqByIdImpl = async () => {
      throw new RfqNotFoundError("rfq-42");
    };

    const res = await handleGetRfq(app, "rfq-42");

    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.equal(payload.error.code, "RFQ_NOT_FOUND");
  });
});

describe("GET /api/rfqs/:id: persistence failure (500, no internal leak)", () => {
  it("maps an RfqPersistenceError to 500 without leaking its message", async () => {
    const app = new FakeRfqApplication();
    const secret = "duplicate key value violates unique constraint";
    app.getRfqByIdImpl = async () => {
      throw new RfqPersistenceError("select", secret);
    };

    const res = await handleGetRfq(app, "rfq-42");

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes(secret));
  });

  it("maps a wholly unexpected thrown value to 500 INTERNAL_ERROR", async () => {
    const app = new FakeRfqApplication();
    app.getRfqByIdImpl = async () => {
      throw new Error("something truly unanticipated");
    };

    const res = await handleGetRfq(app, "rfq-42");

    assert.equal(res.status, 500);
    const payload = await res.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(payload).includes("something truly unanticipated"));
  });
});

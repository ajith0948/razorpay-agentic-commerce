import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { QUOTE_TRANSITIONS, transitionQuote } from "./quote.ts";
import { QUOTE_STATUSES, type QuoteStatus } from "./types.ts";
import { FakeStatusDb } from "./test-support.ts";
import {
  AuditWriteError,
  InvalidTransitionError,
  StaleTransitionError,
  TransitionPersistenceError,
} from "./errors.ts";

const MERCHANT_ID = "merchant-1";
const QUOTE_ID = "quote-1";

function seedQuote(db: FakeStatusDb, status: QuoteStatus) {
  db.seed("quotes", { id: QUOTE_ID, status });
}

/** Mirrors quote.ts's private quoteEventType() -- see that file's doc comment. */
function expectedEventType(from: QuoteStatus, to: QuoteStatus): string {
  if (from === "SENT" && to === "NEGOTIATING") return "NEGOTIATION_STARTED";
  return "QUOTE_STATUS_CHANGED";
}

describe("transitionQuote: valid edges", () => {
  for (const from of QUOTE_STATUSES) {
    for (const to of QUOTE_TRANSITIONS[from]) {
      it(`allows ${from} -> ${to} and writes a ${expectedEventType(from, to)} audit event`, async () => {
        const db = new FakeStatusDb();
        seedQuote(db, from);

        await transitionQuote({
          client: db,
          quoteId: QUOTE_ID,
          from,
          to,
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        });

        assert.equal(db.getRow("quotes", QUOTE_ID)?.status, to);

        const events = [...db.tableMap("audit_events").values()];
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, expectedEventType(from, to));
        assert.equal(events[0].quote_id, QUOTE_ID);
        assert.equal(events[0].merchant_id, MERCHANT_ID);
      });
    }
  }
});

describe("transitionQuote: invalid edges", () => {


  it("rejects DRAFT -> NEGOTIATING (skipping SENT)", async () => {
    const db = new FakeStatusDb();
    seedQuote(db, "DRAFT");
    await assert.rejects(
      () =>
        transitionQuote({
          client: db,
          quoteId: QUOTE_ID,
          from: "DRAFT",
          to: "NEGOTIATING",
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        }),
      InvalidTransitionError,
    );
  });

  for (const terminal of ["ACCEPTED", "EXPIRED", "REJECTED"] as const) {
    it(`rejects every transition out of terminal state ${terminal}`, async () => {
      const db = new FakeStatusDb();
      seedQuote(db, terminal);

      for (const to of QUOTE_STATUSES) {
        if (to === terminal) continue;
        await assert.rejects(
          () =>
            transitionQuote({
              client: db,
              quoteId: QUOTE_ID,
              from: terminal,
              to,
              merchantId: MERCHANT_ID,
              actorType: "SELLER_AGENT",
            }),
          InvalidTransitionError,
        );
      }
    });
  }
});

describe("transitionQuote: stale/concurrent updates", () => {
  it("throws StaleTransitionError when the row's real status no longer matches `from`", async () => {
    const db = new FakeStatusDb();
    seedQuote(db, "NEGOTIATING");

    await assert.rejects(
      () =>
        transitionQuote({
          client: db,
          quoteId: QUOTE_ID,
          from: "SENT", // stale belief; row is actually NEGOTIATING
          to: "NEGOTIATING",
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        }),
      StaleTransitionError,
    );
  });

  it("throws StaleTransitionError when the row does not exist at all", async () => {
    const db = new FakeStatusDb();
    await assert.rejects(
      () =>
        transitionQuote({
          client: db,
          quoteId: "does-not-exist",
          from: "DRAFT",
          to: "SENT",
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        }),
      StaleTransitionError,
    );
  });
});

describe("transitionQuote: database error propagation", () => {
  it("throws TransitionPersistenceError when the update itself fails", async () => {
    const db = new FakeStatusDb({ forcedErrors: { quotes: "connection reset" } });
    seedQuote(db, "DRAFT");

    await assert.rejects(
      () =>
        transitionQuote({
          client: db,
          quoteId: QUOTE_ID,
          from: "DRAFT",
          to: "SENT",
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        }),
      TransitionPersistenceError,
    );
  });

  it("throws AuditWriteError when the audit insert fails (status is not rolled back)", async () => {
    const db = new FakeStatusDb({ forcedErrors: { audit_events: "insert rejected" } });
    seedQuote(db, "DRAFT");

    await assert.rejects(
      () =>
        transitionQuote({
          client: db,
          quoteId: QUOTE_ID,
          from: "DRAFT",
          to: "SENT",
          merchantId: MERCHANT_ID,
          actorType: "SELLER_AGENT",
        }),
      AuditWriteError,
    );

    assert.equal(db.getRow("quotes", QUOTE_ID)?.status, "SENT");
  });
});

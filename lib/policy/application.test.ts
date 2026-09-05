import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createPolicyApplication } from "./application.ts";
import type { MerchantPolicyRow, PolicyDbClient } from "./db.ts";
import { toPolicyDbClient } from "./supabase-policy-db.ts";
import { PolicyPersistenceError, PolicyValidationError } from "./errors.ts";
import type { PostgrestResult } from "../state-machine/index.ts";

const MERCHANT_ID = "merchant-1";

/**
 * Self-contained in-memory fake of PolicyDbClient -- same spirit as
 * lib/order/application.test.ts's FakeOrderDb: a single Map, an
 * error-injection field, no live Supabase connection.
 */
class FakePolicyDb implements PolicyDbClient {
  private readonly policies = new Map<string, MerchantPolicyRow>();
  selectError: { message: string } | null = null;

  seedPolicy(row: MerchantPolicyRow): void {
    this.policies.set(row.merchant_id, row);
  }

  getActiveMerchantPolicy(merchantId: string): PromiseLike<PostgrestResult<MerchantPolicyRow>> {
    if (this.selectError) {
      return Promise.resolve({ data: null, error: this.selectError });
    }
    return Promise.resolve({ data: this.policies.get(merchantId) ?? null, error: null });
  }
}

/** The worked example from ARCHITECTURE.md section 9, verbatim. */
function makeWorkedExamplePolicy(overrides: Partial<MerchantPolicyRow> = {}): MerchantPolicyRow {
  return {
    id: "policy-1",
    merchant_id: MERCHANT_ID,
    max_autonomous_order_value: 100000,
    max_discount_percent: 5,
    minimum_margin_percent: 12,
    inventory_reservation_minutes: 30,
    approval_required_above_amount: 100000,
    active: true,
    allowed_categories: null,
    allowed_delivery_regions: ["Chennai", "Bangalore", "Hyderabad"],
    allowed_payment_methods: null,
    allowed_customer_types: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeApp(db: PolicyDbClient = new FakePolicyDb()) {
  return { app: createPolicyApplication({ db }), db };
}

describe("PolicyApplication.getActiveMerchantPolicy", () => {
  it("returns null (not a thrown error) when the merchant has no active policy", async () => {
    const { app } = makeApp();
    assert.equal(await app.getActiveMerchantPolicy(MERCHANT_ID), null);
  });

  it("returns the mapped policy when one exists", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    const policy = await app.getActiveMerchantPolicy(MERCHANT_ID);

    assert.ok(policy);
    assert.equal(policy.merchantId, MERCHANT_ID);
    assert.equal(policy.maxDiscountPercent, 5);
    assert.equal(policy.approvalRequiredAboveAmount, 100000);
    assert.deepEqual(policy.allowedDeliveryRegions, ["Chennai", "Bangalore", "Hyderabad"]);
  });

  it("throws PolicyPersistenceError on a database failure", async () => {
    const db = new FakePolicyDb();
    db.selectError = { message: "connection reset" };
    const { app } = makeApp(db);

    await assert.rejects(() => app.getActiveMerchantPolicy(MERCHANT_ID), PolicyPersistenceError);
  });
});

describe("PolicyApplication.evaluate -- ARCHITECTURE.md section 9 worked examples", () => {
  it("ALLOWED: an action within every configured limit", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, {
      amount: 50000,
      discountPercent: 5,
      deliveryRegion: "Chennai",
    });

    assert.equal(decision.outcome, "ALLOWED");
    assert.deepEqual(decision.violations, []);
    assert.ok(decision.policy);
  });

  it("BLOCKED: requested discount exceeds the maximum (5%)", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, { discountPercent: 15 });

    assert.equal(decision.outcome, "BLOCKED");
    assert.equal(decision.violations.length, 1);
    assert.equal(decision.violations[0]?.field, "discountPercent");
  });

  it("BLOCKED: delivery region is not in the merchant's allowed regions", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, { deliveryRegion: "Mumbai" });

    assert.equal(decision.outcome, "BLOCKED");
    assert.equal(decision.violations[0]?.field, "deliveryRegion");
  });

  it("BLOCKED: category is not in the merchant's allowed categories", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy({ allowed_categories: ["Corrugated Boxes"] }));
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, { category: "Mailers" });

    assert.equal(decision.outcome, "BLOCKED");
    assert.equal(decision.violations[0]?.field, "category");
  });

  it("does not check category/region when the policy leaves that dimension unrestricted (null)", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy({ allowed_categories: null }));
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, { category: "Anything At All" });

    assert.equal(decision.outcome, "ALLOWED");
  });

  it("APPROVAL_REQUIRED: order value exceeds the worked example's Rs.100,000 threshold (Rs.114,000, section 12)", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, { amount: 114000 });

    assert.equal(decision.outcome, "APPROVAL_REQUIRED");
    assert.deepEqual(decision.violations, []);
  });

  it("an amount exactly at the threshold is still ALLOWED (the rule is strictly greater-than)", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, { amount: 100000 });

    assert.equal(decision.outcome, "ALLOWED");
  });

  it("BLOCKED takes priority over APPROVAL_REQUIRED when both conditions fire", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, { amount: 200000, discountPercent: 50 });

    assert.equal(decision.outcome, "BLOCKED");
    assert.equal(decision.violations[0]?.field, "discountPercent");
  });

  it("collects every violated dimension, not just the first", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    const decision = await app.evaluate(MERCHANT_ID, { discountPercent: 50, deliveryRegion: "Mumbai" });

    assert.equal(decision.violations.length, 2);
    assert.deepEqual(
      decision.violations.map((v) => v.field).sort(),
      ["deliveryRegion", "discountPercent"],
    );
  });

  it("BLOCKED (fails closed, policy: null) when the merchant has no active policy at all", async () => {
    const { app } = makeApp();

    const decision = await app.evaluate(MERCHANT_ID, { amount: 1 });

    assert.equal(decision.outcome, "BLOCKED");
    assert.equal(decision.policy, null);
    assert.equal(decision.reasons.length, 1);
  });

  it("never throws for a policy violation -- BLOCKED and APPROVAL_REQUIRED are structured return values", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    // No assert.rejects anywhere in this describe block is itself part of
    // the proof; this test additionally asserts the promise settles.
    await assert.doesNotReject(() => app.evaluate(MERCHANT_ID, { discountPercent: 99, amount: 999999 }));
  });

  it("rejects malformed input with PolicyValidationError rather than silently coercing it", async () => {
    const db = new FakePolicyDb();
    db.seedPolicy(makeWorkedExamplePolicy());
    const { app } = makeApp(db);

    await assert.rejects(() => app.evaluate(MERCHANT_ID, { amount: -5 }), PolicyValidationError);
    await assert.rejects(() => app.evaluate(MERCHANT_ID, { discountPercent: Number.NaN }), PolicyValidationError);
  });
});

describe("boundary integrity: the Policy application layer is read-only", () => {
  it("the Supabase-backed PolicyDbClient exposes only one read operation -- no insert/update/delete exists to call", () => {
    const client = toPolicyDbClient({} as unknown as SupabaseClient);
    assert.deepEqual(Object.keys(client).sort(), ["getActiveMerchantPolicy"]);
    assert.equal(Reflect.has(client, "update"), false);
    assert.equal(Reflect.has(client, "insert"), false);
    assert.equal(Reflect.has(client, "delete"), false);
  });
});

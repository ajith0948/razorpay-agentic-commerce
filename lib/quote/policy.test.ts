import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertDiscountWithinPolicy } from "./policy.ts";
import { QuotePolicyLimitError } from "./errors.ts";

describe("assertDiscountWithinPolicy", () => {
  it("does not throw when the discount is under the policy limit", () => {
    assert.doesNotThrow(() => assertDiscountWithinPolicy(3, 5));
  });

  it("does not throw when the discount exactly equals the policy limit", () => {
    assert.doesNotThrow(() => assertDiscountWithinPolicy(5, 5));
  });

  it("does not throw for a zero discount, regardless of the policy limit", () => {
    assert.doesNotThrow(() => assertDiscountWithinPolicy(0, 0));
  });

  it("throws QuotePolicyLimitError when the discount exceeds the policy limit", () => {
    assert.throws(() => assertDiscountWithinPolicy(15, 5), QuotePolicyLimitError);
  });

  it("throws with the offending values attached, for a future API layer to report", () => {
    try {
      assertDiscountWithinPolicy(15, 5);
      assert.fail("expected assertDiscountWithinPolicy to throw");
    } catch (err) {
      assert.ok(err instanceof QuotePolicyLimitError);
      assert.equal(err.discountPercent, 15);
      assert.equal(err.maxDiscountPercent, 5);
    }
  });

  it("handles fractional percentages (matches the numeric(5,2) column precision)", () => {
    assert.doesNotThrow(() => assertDiscountWithinPolicy(4.99, 5));
    assert.throws(() => assertDiscountWithinPolicy(5.01, 5), QuotePolicyLimitError);
  });
});

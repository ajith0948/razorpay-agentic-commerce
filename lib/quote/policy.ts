/**
 * The one pricing/policy rule Phase 6 actually implements, isolated into a
 * small pure function per Step 5's instruction ("isolate it into a small
 * pure function that is independently testable").
 *
 * DATABASE.md section 10: "A quote must never exceed merchant policy
 * limits." The only Quote field that a documented merchant-policy value
 * directly bounds is discount_percent, against merchant_policies'
 * max_discount_percent (ARCHITECTURE.md section 9's own worked example;
 * seeded in supabase/seed.sql at 5%). No other Quote field
 * (total_amount/delivery_days/...) has a corresponding policy limit
 * documented anywhere, so no other check is invented here.
 *
 * This is NOT the policy engine (ARCHITECTURE.md section 9 / AGENTS.md
 * section 5) -- it takes plain numbers in and either returns or throws, it
 * has no notion of negotiation, approval routing, or any of the other
 * policy dimensions (max_autonomous_order_value, minimum_margin_percent,
 * allowed regions, ...) that engine will eventually own. It only checks the
 * one limit DATABASE.md section 10 already states applies to a Quote at
 * creation time, using whatever policy value the caller supplies.
 */

import { QuotePolicyLimitError } from "./errors.ts";

/**
 * Throws QuotePolicyLimitError if `discountPercent` exceeds
 * `maxDiscountPercent`. Does nothing (no return value) when the discount is
 * within the limit -- there is no adjusted/derived value to hand back, this
 * is a pass/fail check, not a calculation.
 */
export function assertDiscountWithinPolicy(
  discountPercent: number,
  maxDiscountPercent: number,
): void {
  if (discountPercent > maxDiscountPercent) {
    throw new QuotePolicyLimitError(discountPercent, maxDiscountPercent);
  }
}

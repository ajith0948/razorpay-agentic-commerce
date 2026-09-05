/**
 * The Policy application layer -- the previously-missing deterministic
 * "Policy Engine" ARCHITECTURE.md section 9 and DATABASE.md section 7
 * describe, and IMPLEMENTATION_PLAN.md's own Phase 8 ("Policy Engine") task
 * list calls for ("Create deterministic policy evaluator... Return
 * structured allow/block/approval-required decisions"). This is the ONLY
 * module in the codebase that decides ALLOWED / APPROVAL_REQUIRED / BLOCKED
 * for a proposed action against merchant policy. No LLM, no randomness, no
 * hidden state -- evaluate() is a pure function of (policy row, input).
 *
 * Dependency direction: Policy application layer -> Supabase (read-only).
 * There is no lib/runtime/lib/state-machine dependency here at all: policy
 * evaluation never mutates anything, so there is no lifecycle transition to
 * dispatch. This mirrors why lib/rfq's requirements-parser has no runtime
 * dependency either -- a pure read/compute concern does not need the
 * transition boundary.
 *
 * Decision rules -- every one traceable to a specific documented source,
 * none invented:
 *
 *   1. discountPercent > policy.maxDiscountPercent -> BLOCKED.
 *      ARCHITECTURE.md section 9: "If requested discount > 5%: reject
 *      negotiation."
 *   2. category present, policy.allowedCategories non-null, category not
 *      in that list -> BLOCKED. DATABASE.md section 7: allowed_categories
 *      is "additional policy data" and "Policy enforcement must happen in
 *      deterministic application code" -- this is that enforcement.
 *   3. deliveryRegion present, policy.allowedDeliveryRegions non-null,
 *      region not in that list -> BLOCKED. ARCHITECTURE.md section 9: "If
 *      delivery region is unsupported: reject or propose alternative" (this
 *      module always takes the "reject" branch -- proposing an alternative
 *      region is a negotiation-UX concern for a caller to build on top of a
 *      BLOCKED decision, not something the engine invents on its own).
 *   4. amount > policy.approvalRequiredAboveAmount -> APPROVAL_REQUIRED,
 *      provided none of 1-3 already produced BLOCKED. ARCHITECTURE.md
 *      section 9: "If order value > ₹100,000: require human approval";
 *      section 12's worked example (quote Rs.114,000 vs. autonomous limit
 *      Rs.100,000 -> APPROVAL REQUIRED). This module compares against
 *      approval_required_above_amount specifically (not
 *      max_autonomous_order_value) because that is the field whose name and
 *      DATABASE.md section 7 documented purpose directly match "the amount
 *      above which approval is required" -- and supabase/seed.sql's own
 *      comment on this exact column confirms the two fields are meant to
 *      express the same autonomous ceiling ("approval_required_above_amount
 *      is set equal to max_autonomous_order_value ... ties approval to
 *      crossing that same autonomous ceiling"), so evaluating the
 *      more-precisely-named field is not a narrower or different rule than
 *      the one the docs describe, just the correctly-targeted column.
 *      max_autonomous_order_value itself is still exposed on MerchantPolicy
 *      (e.g. for a get_merchant_policy read tool) but this module does not
 *      separately branch on it -- the docs describe exactly one amount
 *      threshold's worth of behavior (ALLOWED below it, APPROVAL_REQUIRED
 *      above it), and inventing a second, differently-consequenced ceiling
 *      on top of that would be exactly the kind of unrequested policy
 *      dimension this phase must not add.
 *   5. quantity vs. available inventory ("If requested quantity > available
 *      inventory: reject or propose alternative") is intentionally NOT
 *      implemented: there is no inventory service/application layer
 *      anywhere in the codebase yet (confirmed absent -- Catalog/Inventory
 *      services remain unbuilt per IMPLEMENTATION_PLAN.md), so
 *      PolicyEvaluationInput has no quantity/inventory field to check. This
 *      is a reported gap (see the Phase 9 final report), not a silently
 *      invented approximation.
 *   6. No active policy row for the merchant -> BLOCKED, with
 *      `policy: null`. Not documented as an explicit rule anywhere, but the
 *      only safe default: every one of rules 1-4 requires a policy value to
 *      compare against, and this codebase's own existing precedent
 *      (lib/quote/application.ts's assertDiscountWithinPolicy call) treats
 *      an absent policy permissively (silently skips the check) only for
 *      Quote's pre-existing, narrower discount guard -- a choice this
 *      module deliberately does not repeat, because unlike that single
 *      backstop check, lib/policy/ is the Agent layer's primary safety
 *      boundary (Phase 9's own mandate: "no policy bypass"), where failing
 *      open on missing configuration would silently defeat that mandate
 *      rather than merely narrow one quote-time check.
 *
 * Precedence when multiple rules fire: any BLOCKED violation (1-3) takes
 * priority over APPROVAL_REQUIRED (4) -- an action that is invalid on its
 * own terms (bad discount, disallowed category/region) is not something a
 * human approval can cure, so there is no reason to report it as merely
 * "needs a human" when it is actually invalid. All violations across
 * dimensions 1-3 are collected (not short-circuited on the first) so a
 * caller sees the complete picture in one round trip.
 */

import { PolicyPersistenceError, PolicyValidationError } from "./errors.ts";
import type { MerchantPolicyRow, PolicyDbClient } from "./db.ts";
import { toPolicyDbClient } from "./supabase-policy-db.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import type { MerchantPolicy, PolicyDecision, PolicyEvaluationInput, PolicyViolation } from "./types.ts";

export interface PolicyApplicationDeps {
  db: PolicyDbClient;
}

export interface PolicyApplication {
  /**
   * Reads the merchant's one active policy row. Returns `null` (not a
   * thrown error) when none exists -- see errors.ts's doc comment. Throws
   * PolicyPersistenceError on a genuine database failure.
   */
  getActiveMerchantPolicy(merchantId: string): Promise<MerchantPolicy | null>;
  /**
   * Deterministically evaluates `input` against the merchant's active
   * policy and returns a structured decision. Never throws for a policy
   * violation -- only PolicyValidationError (malformed input) or
   * PolicyPersistenceError (database failure) are ever thrown.
   */
  evaluate(merchantId: string, input: PolicyEvaluationInput): Promise<PolicyDecision>;
}

function mapPolicyRow(row: MerchantPolicyRow): MerchantPolicy {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    maxAutonomousOrderValue: row.max_autonomous_order_value,
    maxDiscountPercent: row.max_discount_percent,
    minimumMarginPercent: row.minimum_margin_percent,
    inventoryReservationMinutes: row.inventory_reservation_minutes,
    approvalRequiredAboveAmount: row.approval_required_above_amount,
    active: row.active,
    allowedCategories: row.allowed_categories,
    allowedDeliveryRegions: row.allowed_delivery_regions,
    allowedPaymentMethods: row.allowed_payment_methods,
    allowedCustomerTypes: row.allowed_customer_types,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Application-level input validation, distinct from the database's own
 * constraints. Every field of PolicyEvaluationInput is optional (a caller
 * supplies only the dimensions relevant to its proposed action -- see
 * types.ts), so validation here only rejects values that are present but
 * nonsensical, mirroring the minimal-checks philosophy of every other
 * layer's validateCreateXInput.
 */
function validateEvaluationInput(input: PolicyEvaluationInput): void {
  if (input.amount !== undefined && (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount < 0)) {
    throw new PolicyValidationError("amount", "must be a non-negative finite number");
  }
  if (
    input.discountPercent !== undefined &&
    (typeof input.discountPercent !== "number" || !Number.isFinite(input.discountPercent) || input.discountPercent < 0)
  ) {
    throw new PolicyValidationError("discountPercent", "must be a non-negative finite number");
  }
  if (input.category !== undefined && (typeof input.category !== "string" || input.category.trim() === "")) {
    throw new PolicyValidationError("category", "must be a non-empty string when provided");
  }
  if (input.deliveryRegion !== undefined && (typeof input.deliveryRegion !== "string" || input.deliveryRegion.trim() === "")) {
    throw new PolicyValidationError("deliveryRegion", "must be a non-empty string when provided");
  }
}

export function createPolicyApplication(deps: PolicyApplicationDeps): PolicyApplication {
  const { db } = deps;

  async function getActiveMerchantPolicy(merchantId: string): Promise<MerchantPolicy | null> {
    const { data, error } = await db.getActiveMerchantPolicy(merchantId);

    if (error) {
      throw new PolicyPersistenceError("select", error.message);
    }
    if (!data) {
      return null;
    }

    return mapPolicyRow(data);
  }

  async function evaluate(merchantId: string, input: PolicyEvaluationInput): Promise<PolicyDecision> {
    validateEvaluationInput(input);

    const policy = await getActiveMerchantPolicy(merchantId);

    if (!policy) {
      return {
        outcome: "BLOCKED",
        reasons: [`No active merchant policy configured for merchant ${merchantId}; cannot evaluate action`],
        violations: [],
        policy: null,
      };
    }

    const violations: PolicyViolation[] = [];

    if (input.discountPercent !== undefined && input.discountPercent > policy.maxDiscountPercent) {
      violations.push({
        field: "discountPercent",
        reason: `Requested discount ${input.discountPercent}% exceeds maximum allowed ${policy.maxDiscountPercent}%`,
      });
    }

    if (
      input.category !== undefined &&
      policy.allowedCategories !== null &&
      !policy.allowedCategories.includes(input.category)
    ) {
      violations.push({
        field: "category",
        reason: `Category "${input.category}" is not in the merchant's allowed categories (${policy.allowedCategories.join(", ")})`,
      });
    }

    if (
      input.deliveryRegion !== undefined &&
      policy.allowedDeliveryRegions !== null &&
      !policy.allowedDeliveryRegions.includes(input.deliveryRegion)
    ) {
      violations.push({
        field: "deliveryRegion",
        reason: `Delivery region "${input.deliveryRegion}" is not in the merchant's allowed delivery regions (${policy.allowedDeliveryRegions.join(", ")})`,
      });
    }

    if (violations.length > 0) {
      return {
        outcome: "BLOCKED",
        reasons: violations.map((v) => v.reason),
        violations,
        policy,
      };
    }

    if (input.amount !== undefined && input.amount > policy.approvalRequiredAboveAmount) {
      return {
        outcome: "APPROVAL_REQUIRED",
        reasons: [
          `Amount ${input.amount} exceeds the merchant's autonomous approval threshold of ${policy.approvalRequiredAboveAmount}`,
        ],
        violations: [],
        policy,
      };
    }

    return { outcome: "ALLOWED", reasons: [], violations: [], policy };
  }

  return { getActiveMerchantPolicy, evaluate };
}

/**
 * Convenience factory for real application code: a PolicyApplication backed
 * by the live database. Constructed fresh per call, never at module scope,
 * matching every other layer's createSupabaseXApplication() convention.
 */
export function createSupabasePolicyApplication(): PolicyApplication {
  const supabase = createServiceRoleClient();
  return createPolicyApplication({ db: toPolicyDbClient(supabase) });
}

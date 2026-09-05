/**
 * The Policy Engine's own public domain types -- distinct from the raw
 * database row shape (MerchantPolicyRow, db.ts), which stays internal to
 * this module. Same split as lib/quote/types.ts and lib/rfq/types.ts.
 *
 * This module exists because, before Phase 9, no code anywhere in the
 * repository evaluated a proposed action against the *general* shape of
 * merchant policy ARCHITECTURE.md section 9 and IMPLEMENTATION_PLAN.md
 * section 11 ("Phase 8 -- Policy Engine") describe: only
 * lib/quote/policy.ts's narrow assertDiscountWithinPolicy() exists, and its
 * own doc comment explicitly disclaims being that engine ("it has no notion
 * of negotiation, approval routing, or any of the other policy dimensions
 * ... that engine will eventually own"). lib/policy/ is that
 * previously-missing deterministic evaluator, built now because Phase 9 (the
 * Agent layer)'s own core mandate -- "respect merchant policy", "no policy
 * bypass" -- cannot be honored against real merchant data with only a
 * discount check. It invents no new policy dimensions or values: every
 * field below is an existing merchant_policies column
 * (supabase/migrations/20260901120003_create_core_tables.sql), and the
 * ALLOWED/APPROVAL_REQUIRED/BLOCKED evaluation follows ARCHITECTURE.md
 * section 9's own worked examples exactly (see application.ts).
 */

/**
 * The public representation of a merchant's active policy. camelCase, free
 * of any Supabase/PostgREST response envelope. Field list matches
 * DATABASE.md section 7 / the merchant_policies table exactly -- no
 * invented columns.
 */
export interface MerchantPolicy {
  id: string;
  merchantId: string;
  maxAutonomousOrderValue: number;
  maxDiscountPercent: number;
  minimumMarginPercent: number;
  inventoryReservationMinutes: number;
  approvalRequiredAboveAmount: number;
  active: boolean;
  allowedCategories: readonly string[] | null;
  allowedDeliveryRegions: readonly string[] | null;
  allowedPaymentMethods: readonly string[] | null;
  allowedCustomerTypes: readonly string[] | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A proposed action's relevant values, to be checked against merchant
 * policy. Every field is optional: a caller supplies only the dimensions
 * relevant to the action it is proposing (e.g. a proposed Quote supplies
 * `discountPercent`/`category`/`deliveryRegion`; a proposed Payment supplies
 * `amount`) -- evaluate() only checks the dimensions actually present, per
 * IMPLEMENTATION_PLAN.md section 11's own framing of one deterministic
 * evaluator reused for "Validate quote" / "Validate negotiation proposals" /
 * "Validate payment requests" rather than one bespoke checker per action
 * type.
 */
export interface PolicyEvaluationInput {
  amount?: number;
  discountPercent?: number;
  category?: string;
  deliveryRegion?: string;
}

/**
 * The three outcomes ARCHITECTURE.md section 9 and
 * IMPLEMENTATION_PLAN.md section 11 both use verbatim ("BLOCKED",
 * "HUMAN_APPROVAL_REQUIRED" -- shortened here to APPROVAL_REQUIRED, matching
 * this repository's ApprovalStatus naming convention rather than inventing
 * a differently-worded synonym).
 */
export type PolicyDecisionOutcome = "ALLOWED" | "APPROVAL_REQUIRED" | "BLOCKED";

/** One dimension of `input` that violated a hard policy limit. */
export interface PolicyViolation {
  field: "discountPercent" | "category" | "deliveryRegion";
  reason: string;
}

/**
 * The structured result of evaluate(). `policy` is the policy the decision
 * was computed against -- null only when `outcome` is BLOCKED because the
 * merchant has no active policy configured at all (see application.ts's
 * doc comment on why that case fails closed rather than defaulting to
 * permissive).
 */
export interface PolicyDecision {
  outcome: PolicyDecisionOutcome;
  reasons: readonly string[];
  violations: readonly PolicyViolation[];
  policy: MerchantPolicy | null;
}

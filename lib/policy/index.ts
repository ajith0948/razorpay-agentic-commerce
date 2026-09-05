/**
 * Public barrel for the Policy application layer. Curated on purpose --
 * same discipline as lib/order/index.ts: only the public API surface is
 * exported here. PolicyDbClient/toPolicyDbClient/MerchantPolicyRow (db.ts,
 * supabase-policy-db.ts) are internal wiring and stay un-exported so
 * callers can only reach the Policy application layer through
 * createPolicyApplication()/createSupabasePolicyApplication().
 */

export type {
  MerchantPolicy,
  PolicyDecision,
  PolicyDecisionOutcome,
  PolicyEvaluationInput,
  PolicyViolation,
} from "./types.ts";
export { PolicyPersistenceError, PolicyValidationError } from "./errors.ts";
export type { PolicyApplication, PolicyApplicationDeps } from "./application.ts";
export { createPolicyApplication, createSupabasePolicyApplication } from "./application.ts";

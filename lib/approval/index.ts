/**
 * Public barrel for the Approval application layer. Curated on purpose --
 * same discipline as lib/order/index.ts: only the public API surface is
 * exported here. ApprovalDbClient/toApprovalDbClient/ApprovalRow/
 * NewApprovalRow/QuoteRefRow (db.ts, supabase-approval-db.ts) are internal
 * wiring and stay un-exported so callers can only reach the Approval
 * application layer through
 * createApprovalApplication()/createSupabaseApprovalApplication().
 *
 * No HTTP route imports this yet -- a human-facing Approval decision API is
 * explicitly Phase 10 work (see application.ts's doc comment and the Phase
 * 9 final report's "Remaining work for Phase 10" section).
 */

export type { Approval, CreateApprovalInput } from "./types.ts";
export {
  ApprovalNotFoundError,
  ApprovalPersistenceError,
  ApprovalQuoteNotFoundError,
  ApprovalValidationError,
} from "./errors.ts";
export type {
  ApprovalApplication,
  ApprovalApplicationDeps,
  TransitionApprovalStatusInput,
} from "./application.ts";
export { createApprovalApplication, createSupabaseApprovalApplication } from "./application.ts";

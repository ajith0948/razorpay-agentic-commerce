/**
 * Barrel export for the state machine module. Application code (API
 * routes, agent tool implementations in a later phase) should import from
 * "lib/state-machine" rather than reaching into individual files -- this is
 * the single centralized surface IMPLEMENTATION_PLAN.md's Phase 2 spec asks
 * for, and the only place status transitions are allowed to happen. The LLM
 * itself must never call anything below directly (AGENTS.md section 4/6):
 * it can only ever reach these functions through a backend tool
 * implementation that supplies its own trusted `client`/`merchantId`/
 * `actorType`, never values an LLM invented.
 */

// Types/enums mirroring the Postgres enums, plus the actor-type union every
// transition function requires the caller to supply.
export * from "./types.ts";

// Controlled error classes every transition function can throw.
export * from "./errors.ts";

// The generic transition-table engine (shared by every entity below).
export { assertValidTransition, isValidTransition } from "./transition-table.ts";
export type { TransitionTable } from "./transition-table.ts";

// The narrow DB client contract a real Supabase client (or a test fake)
// must satisfy to be passed as `client` to any transition function.
export type {
  PostgrestResult,
  StatusDbClient,
  StatusDbFilterBuilder,
  StatusDbTableClient,
} from "./db.ts";

// Shared audit-event writer.
export { recordAuditEvent } from "./audit.ts";
export type { AuditEventInput } from "./audit.ts";

// RFQ
export { RFQ_TRANSITIONS, transitionRfq } from "./rfq.ts";
export type { TransitionRfqParams } from "./rfq.ts";

// Quote
export { QUOTE_TRANSITIONS, transitionQuote } from "./quote.ts";
export type { TransitionQuoteParams } from "./quote.ts";

// Order
export { ORDER_TRANSITIONS, transitionOrder } from "./order.ts";
export type { TransitionOrderParams } from "./order.ts";

// Payment
export { markPaymentPaid, PAYMENT_TRANSITIONS, transitionPayment } from "./payment.ts";
export type {
  MarkPaymentPaidParams,
  PaymentVerificationEvidence,
  TransitionPaymentParams,
} from "./payment.ts";

// Approval
export { APPROVAL_TRANSITIONS, transitionApproval } from "./approval.ts";
export type { TransitionApprovalParams } from "./approval.ts";

// Agent Session
export { AGENT_SESSION_TRANSITIONS, transitionAgentSession } from "./agent-session.ts";
export type { TransitionAgentSessionParams } from "./agent-session.ts";

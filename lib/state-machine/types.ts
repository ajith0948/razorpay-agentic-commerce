/**
 * Status types for Phase 2 (State Machine Implementation).
 *
 * Each union below is copied verbatim from the corresponding PostgreSQL
 * enum created in supabase/migrations -- values, order, and casing all
 * match exactly, so a value read from or written to the database needs no
 * translation at this boundary. String literal unions are used instead of
 * TypeScript's `enum` keyword: they compile to nothing at runtime (a
 * Postgres enum value already *is* a plain string over the wire), and
 * unlike `enum` they are compatible with Node's built-in TypeScript
 * type-stripping (used to run this module's *.test.ts files directly --
 * see lib/state-machine/package.json), which cannot execute `enum`
 * declarations.
 */

// supabase/migrations/20260901120002_create_enums.sql -- rfq_status
// (DATABASE.md section 9, "RFQ State Machine").
export type RfqStatus =
  | "CREATED"
  | "PROCESSING"
  | "QUOTED"
  | "NEGOTIATING"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export const RFQ_STATUSES: readonly RfqStatus[] = [
  "CREATED",
  "PROCESSING",
  "QUOTED",
  "NEGOTIATING",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
];

// supabase/migrations/20260901120002_create_enums.sql -- quote_status
// (DATABASE.md section 10, "Quote").
export type QuoteStatus =
  | "DRAFT"
  | "SENT"
  | "NEGOTIATING"
  | "ACCEPTED"
  | "EXPIRED"
  | "REJECTED";

export const QUOTE_STATUSES: readonly QuoteStatus[] = [
  "DRAFT",
  "SENT",
  "NEGOTIATING",
  "ACCEPTED",
  "EXPIRED",
  "REJECTED",
];

// supabase/migrations/20260901120002_create_enums.sql -- order_status
// (DATABASE.md section 14, "Order").
export type OrderStatus =
  | "CREATED"
  | "PAYMENT_PENDING"
  | "PAID"
  | "CONFIRMED"
  | "PAYMENT_FAILED"
  | "CANCELLED";

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "CREATED",
  "PAYMENT_PENDING",
  "PAID",
  "CONFIRMED",
  "PAYMENT_FAILED",
  "CANCELLED",
];

// supabase/migrations/20260901120002_create_enums.sql -- payment_status
// (DATABASE.md section 13, "Payment").
export type PaymentStatus = "CREATED" | "PENDING" | "PAID" | "FAILED";

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "CREATED",
  "PENDING",
  "PAID",
  "FAILED",
];

// supabase/migrations/20260901120002_create_enums.sql -- approval_status
// (DATABASE.md section 12, "Approval").
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
];

// supabase/migrations/20260901140000_add_agent_session_status_enum.sql --
// agent_session_status. DATABASE.md section 15 lists the "status" field but
// (still, as of this phase) does not enumerate its values there; the four
// values below are the ones the enum migration defined, and match the
// lifecycle this phase's task described.
export type AgentSessionStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export const AGENT_SESSION_STATUSES: readonly AgentSessionStatus[] = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

// supabase/migrations/20260901120002_create_enums.sql -- audit_actor_type
// (DATABASE.md section 16, "Audit Event"). Every transition function in
// this module requires the caller to supply one of these: the transition
// functions never guess who/what initiated a change.
export type AuditActorType =
  | "BUYER"
  | "SELLER_AGENT"
  | "HUMAN_MERCHANT"
  | "SYSTEM"
  | "RAZORPAY";

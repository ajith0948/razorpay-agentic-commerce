/**
 * Barrel export for the Phase 3 runtime integration boundary. Application
 * code (a future API route, agent tool implementation, etc.) should import
 * from "lib/runtime" rather than reaching into individual files.
 *
 * Deliberately curated, not `export *`: this file exports the AppEvent
 * vocabulary and the two runtime factories, and NOTHING that would let a
 * consumer reach a raw database client or mutate state some way other than
 * dispatch() -- e.g. toStatusDbClient() (supabase-status-db.ts) is
 * intentionally not re-exported here. That is what "prevent consumers from
 * directly mutating state" means at the barrel level, mirroring how
 * lib/state-machine/index.ts's own doc comment frames itself as the one
 * place application code is meant to import from.
 */

export type {
  AgentSessionTransitionEvent,
  AppEvent,
  ApprovalTransitionEvent,
  OrderTransitionEvent,
  PaymentMarkPaidEvent,
  PaymentTransitionEvent,
  QuoteTransitionEvent,
  RfqTransitionEvent,
} from "./events.ts";

export { createStateRuntime, createSupabaseStateRuntime } from "./state-runtime.ts";
export type { DispatchResult, StateRuntime } from "./state-runtime.ts";

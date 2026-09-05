/**
 * Public barrel for the Order application layer. Curated on purpose -- same
 * discipline as lib/quote/index.ts: only the public API surface is exported
 * here. OrderDbClient/toOrderDbClient/OrderRow/NewOrderRow/QuoteRefRow
 * (db.ts, supabase-order-db.ts) are internal wiring and stay un-exported so
 * callers can only reach the Order application layer through
 * createOrderApplication()/createSupabaseOrderApplication().
 *
 * No HTTP route imports this yet -- an Order API is explicitly out of scope
 * for this phase (Phase 8, Step 3/"Explicitly out of scope").
 */

export type { CreateOrderInput, Order } from "./types.ts";
export {
  OrderAlreadyExistsError,
  OrderNotFoundError,
  OrderPersistenceError,
  OrderQuoteNotFoundError,
  OrderQuoteStateError,
  OrderValidationError,
} from "./errors.ts";
export type {
  OrderApplication,
  OrderApplicationDeps,
  TransitionOrderStatusInput,
} from "./application.ts";
export { createOrderApplication, createSupabaseOrderApplication } from "./application.ts";

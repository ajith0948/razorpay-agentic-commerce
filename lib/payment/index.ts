/**
 * Public barrel for the Payment application layer. Curated on purpose --
 * same discipline as lib/order/index.ts: only the public API surface is
 * exported here. PaymentDbClient/toPaymentDbClient/PaymentRow/NewPaymentRow/
 * OrderRefRow (db.ts, supabase-payment-db.ts) are internal wiring and stay
 * un-exported so callers can only reach the Payment application layer
 * through createPaymentApplication()/createSupabasePaymentApplication().
 *
 * No HTTP route imports this yet -- a Payment API is explicitly out of
 * scope for this phase (Phase 8, Step 7/"Explicitly out of scope"). No
 * Razorpay SDK import here either -- see application.ts's doc comment.
 */

export type { CreatePaymentInput, Payment } from "./types.ts";
export {
  PaymentNotFoundError,
  PaymentOrderNotFoundError,
  PaymentOrderStateError,
  PaymentPersistenceError,
  PaymentValidationError,
} from "./errors.ts";
export type {
  MarkPaymentPaidInput,
  PaymentApplication,
  PaymentApplicationDeps,
  TransitionPaymentStatusInput,
} from "./application.ts";
export { createPaymentApplication, createSupabasePaymentApplication } from "./application.ts";

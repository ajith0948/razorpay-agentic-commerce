/**
 * Public barrel for the Quote application layer. Curated on purpose -- same
 * discipline as lib/rfq/index.ts: only the public API surface is exported
 * here. QuoteDbClient/toQuoteDbClient/QuoteRow/NewQuoteRow/RfqRefRow/
 * MerchantPolicyRow (db.ts, supabase-quote-db.ts) and
 * assertDiscountWithinPolicy (policy.ts) are internal wiring and stay
 * un-exported so callers can only reach the Quote application layer through
 * createQuoteApplication()/createSupabaseQuoteApplication().
 *
 * No HTTP route imports this yet -- the Quote API is Phase 7, not this
 * phase (Phase 6, Step 12).
 */

export type { Quote, CreateQuoteInput } from "./types.ts";
export {
  QuoteNotFoundError,
  QuotePersistenceError,
  QuotePolicyLimitError,
  QuoteRfqNotFoundError,
  QuoteRfqStateError,
  QuoteValidationError,
} from "./errors.ts";
export type {
  QuoteApplication,
  QuoteApplicationDeps,
  TransitionQuoteStatusInput,
} from "./application.ts";
export { createQuoteApplication, createSupabaseQuoteApplication } from "./application.ts";

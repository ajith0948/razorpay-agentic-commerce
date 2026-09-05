/**
 * Public barrel for the RFQ application layer. Curated on purpose -- same
 * discipline as lib/runtime/index.ts and lib/state-machine/index.ts: only
 * the public API surface is exported here. RfqDbClient/toRfqDbClient/
 * RfqRow/NewRfqRow (db.ts, supabase-rfq-db.ts) are internal wiring and stay
 * un-exported so callers can only reach the RFQ application layer through
 * createRfqApplication()/createSupabaseRfqApplication(). The parser's own
 * types (RequirementsParser, ParsedRfqRequirements,
 * createDeterministicRequirementsParser -- requirements-parser.ts) are, for
 * the same reason, also internal wiring for this phase: nothing outside
 * lib/rfq needs to call the parser directly, only through
 * RfqApplication.processRfqRequirements().
 */

export type { Rfq, CreateRfqInput } from "./types.ts";
export {
  RfqValidationError,
  RfqNotFoundError,
  RfqPersistenceError,
  RfqRequirementsParsingError,
} from "./errors.ts";
export type {
  RfqApplication,
  RfqApplicationDeps,
  TransitionRfqStatusInput,
} from "./application.ts";
export { createRfqApplication, createSupabaseRfqApplication } from "./application.ts";

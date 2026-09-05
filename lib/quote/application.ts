/**
 * The Quote application/domain layer. This is the ONLY module the rest of
 * the application should import to create, read, or transition a Quote.
 *
 * Dependency direction (mirrors lib/rfq/application.ts):
 *   Quote application layer -> lib/runtime -> lib/state-machine -> Supabase
 *
 * This file owns input validation, the create/read data access calls (via
 * the injected QuoteDbClient port, db.ts), the RFQ-reference and
 * merchant-policy checks createQuote() requires, and mapping QuoteRow ->
 * Quote. It does NOT own a transition table, does NOT duplicate
 * lib/state-machine's QUOTE_TRANSITIONS, and NEVER issues
 * `supabase.from("quotes").update({status: ...})` itself -- every status
 * change is a lib/runtime AppEvent dispatched through the injected
 * StateRuntime, exactly as lib/rfq/application.ts already established.
 *
 * createQuoteApplication() takes its dependencies by injection (a
 * QuoteDbClient and a StateRuntime), the same DI pattern
 * createRfqApplication() already established -- so this layer is
 * unit-testable against fakes, with no live Supabase connection (see
 * application.test.ts). createSupabaseQuoteApplication() below is the
 * convenience factory real application code calls to get one backed by the
 * live database.
 */

import type { StateRuntime } from "../runtime/index.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import { toStatusDbClient } from "../runtime/supabase-status-db.ts";
import { createStateRuntime } from "../runtime/state-runtime.ts";
import { RFQ_TRANSITIONS } from "../state-machine/index.ts";
import {
  QuoteNotFoundError,
  QuotePersistenceError,
  QuoteRfqNotFoundError,
  QuoteRfqStateError,
  QuoteValidationError,
} from "./errors.ts";
import { assertDiscountWithinPolicy } from "./policy.ts";
import type { QuoteDbClient, QuoteRow } from "./db.ts";
import { toQuoteDbClient } from "./supabase-quote-db.ts";
import type { CreateQuoteInput, Quote } from "./types.ts";
import type { QuoteTransitionEvent } from "../runtime/events.ts";

/**
 * Everything transitionQuoteStatus() needs, mirroring lib/runtime's
 * QuoteTransitionEvent minus the `type` discriminant createQuoteApplication()
 * supplies itself -- same derivation lib/rfq/application.ts's
 * TransitionRfqStatusInput uses.
 */
export type TransitionQuoteStatusInput = Omit<QuoteTransitionEvent, "type">;

export interface QuoteApplicationDeps {
  db: QuoteDbClient;
  runtime: StateRuntime;
}

export interface QuoteApplication {
  /**
   * Validates `input`, verifies the referenced RFQ exists and is eligible
   * to receive a Quote, checks discount_percent against the merchant's
   * active policy (if one exists), inserts the row, and returns it. Does
   * not go through lib/runtime: DRAFT has no incoming edge in
   * QUOTE_TRANSITIONS (lib/state-machine/quote.ts) -- it is never a
   * transition target, only the schema's own `status default 'DRAFT'`.
   * This preserves that design rather than routing a non-transition
   * through the transition boundary, exactly as createRfq() does for RFQ's
   * own CREATED default.
   */
  createQuote(input: CreateQuoteInput): Promise<Quote>;
  /** Throws QuoteNotFoundError (not a null return) when no row matches `quoteId`. */
  getQuoteById(quoteId: string): Promise<Quote>;
  /**
   * Dispatches a QUOTE_TRANSITION event through lib/runtime and returns the
   * Quote's fresh state. lib/state-machine remains the sole authority on
   * whether the edge is valid -- this function adds no Quote-specific
   * transition rule of its own. Errors
   * (InvalidTransitionError/StaleTransitionError/TransitionPersistenceError/
   * AuditWriteError) propagate unchanged from lib/runtime/lib/state-machine.
   */
  transitionQuoteStatus(params: TransitionQuoteStatusInput): Promise<Quote>;
}

function mapQuoteRow(row: QuoteRow): Quote {
  return {
    id: row.id,
    rfqId: row.rfq_id,
    merchantId: row.merchant_id,
    buyerId: row.buyer_id,
    totalAmount: row.total_amount,
    currency: row.currency,
    discountPercent: row.discount_percent,
    deliveryDays: row.delivery_days,
    deliveryLocation: row.delivery_location,
    validUntil: row.valid_until,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Application-level input validation -- distinct from and in addition to
 * the database's own NOT NULL/CHECK constraints, which still apply and
 * surface as QuotePersistenceError if violated. Deliberately minimal, same
 * philosophy as lib/rfq/application.ts's validateCreateRfqInput: only what
 * DATABASE.md section 10's fields and their CHECK constraints actually
 * require, plus the same expiry-must-be-future rule createRfq() already
 * applies to its own analogous nullable date field (expiresAt).
 */
function validateCreateQuoteInput(input: CreateQuoteInput): void {
  if (typeof input.rfqId !== "string" || input.rfqId.trim() === "") {
    throw new QuoteValidationError("rfqId", "is required");
  }
  if (typeof input.totalAmount !== "number" || !Number.isFinite(input.totalAmount)) {
    throw new QuoteValidationError("totalAmount", "must be a number");
  }
  if (input.totalAmount < 0) {
    throw new QuoteValidationError("totalAmount", "must not be negative");
  }
  if (typeof input.currency !== "string" || input.currency.trim() === "") {
    throw new QuoteValidationError("currency", "is required");
  }
  if (input.discountPercent !== undefined) {
    if (typeof input.discountPercent !== "number" || !Number.isFinite(input.discountPercent)) {
      throw new QuoteValidationError("discountPercent", "must be a number");
    }
    if (input.discountPercent < 0 || input.discountPercent > 100) {
      throw new QuoteValidationError("discountPercent", "must be between 0 and 100");
    }
  }
  if (typeof input.deliveryDays !== "number" || !Number.isInteger(input.deliveryDays)) {
    throw new QuoteValidationError("deliveryDays", "must be an integer");
  }
  if (input.deliveryDays < 0) {
    throw new QuoteValidationError("deliveryDays", "must not be negative");
  }
  if (typeof input.deliveryLocation !== "string" || input.deliveryLocation.trim() === "") {
    throw new QuoteValidationError("deliveryLocation", "is required");
  }
  if (input.validUntil !== undefined && input.validUntil !== null) {
    const parsed = new Date(input.validUntil);
    if (Number.isNaN(parsed.getTime())) {
      throw new QuoteValidationError("validUntil", "must be a valid ISO 8601 date string");
    }
    if (parsed.getTime() <= Date.now()) {
      throw new QuoteValidationError("validUntil", "must be in the future");
    }
  }
}

export function createQuoteApplication(deps: QuoteApplicationDeps): QuoteApplication {
  const { db, runtime } = deps;

  async function getQuoteById(quoteId: string): Promise<Quote> {
    const { data, error } = await db.getQuoteById(quoteId);

    if (error) {
      throw new QuotePersistenceError("select", error.message);
    }
    if (!data) {
      throw new QuoteNotFoundError(quoteId);
    }

    return mapQuoteRow(data);
  }

  async function createQuote(input: CreateQuoteInput): Promise<Quote> {
    validateCreateQuoteInput(input);
    const discountPercent = input.discountPercent ?? 0;

    const { data: rfqRef, error: rfqError } = await db.getRfqRef(input.rfqId);
    if (rfqError) {
      throw new QuotePersistenceError("select-rfq", rfqError.message);
    }
    if (!rfqRef) {
      throw new QuoteRfqNotFoundError(input.rfqId);
    }
    // A Quote may only be created against a non-terminal RFQ. Derived from
    // RFQ_TRANSITIONS (the state machine's own table) rather than a second,
    // separately-maintained list of terminal statuses -- see errors.ts's
    // doc comment on QuoteRfqStateError.
    if (RFQ_TRANSITIONS[rfqRef.status].length === 0) {
      throw new QuoteRfqStateError(input.rfqId, rfqRef.status);
    }

    const { data: policy, error: policyError } = await db.getActiveMerchantPolicy(
      rfqRef.merchant_id,
    );
    if (policyError) {
      throw new QuotePersistenceError("select-policy", policyError.message);
    }
    if (policy) {
      assertDiscountWithinPolicy(discountPercent, policy.max_discount_percent);
    }

    const { data, error } = await db.insertQuote({
      rfq_id: input.rfqId,
      merchant_id: rfqRef.merchant_id,
      buyer_id: rfqRef.buyer_id,
      total_amount: input.totalAmount,
      currency: input.currency,
      discount_percent: discountPercent,
      delivery_days: input.deliveryDays,
      delivery_location: input.deliveryLocation,
      valid_until: input.validUntil ?? null,
    });

    if (error) {
      throw new QuotePersistenceError("insert", error.message);
    }
    if (!data) {
      // Defensive: a successful insert-and-select-one should always return
      // the row. Treated as a persistence error, not silently ignored.
      throw new QuotePersistenceError("insert", "insert reported success but returned no row");
    }

    return mapQuoteRow(data);
  }

  async function transitionQuoteStatus(params: TransitionQuoteStatusInput): Promise<Quote> {
    await runtime.dispatch({ type: "QUOTE_TRANSITION", ...params });
    // dispatch() intentionally returns only {entity, id, status} (see
    // state-runtime.ts) rather than re-reading the row itself. This layer
    // re-fetches so every QuoteApplication method returns the same full
    // Quote shape, exactly like transitionRfqStatus() does.
    return getQuoteById(params.quoteId);
  }

  return { createQuote, getQuoteById, transitionQuoteStatus };
}

/**
 * Convenience factory for real application code: a QuoteApplication backed
 * by the live database. Reuses the existing service-role client factory
 * (lib/supabase/server.ts) and lib/runtime's own toStatusDbClient() adapter
 * -- constructed fresh per call, never at module scope, matching
 * lib/rfq/application.ts's createSupabaseRfqApplication() convention (so
 * this never throws at import/build time if Supabase env vars are unset).
 */
export function createSupabaseQuoteApplication(): QuoteApplication {
  const supabase = createServiceRoleClient();
  return createQuoteApplication({
    db: toQuoteDbClient(supabase),
    runtime: createStateRuntime(toStatusDbClient(supabase)),
  });
}

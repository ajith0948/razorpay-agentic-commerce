/**
 * The RFQ application/domain layer. This is the ONLY module the rest of
 * the application should import to create, read, transition, or process
 * the requirements of an RFQ.
 *
 * Dependency direction (Phase 4 spec; Phase 5 adds the Requirements Parser
 * as this layer's own collaborator, not a new layer of its own):
 *   RFQ application layer -> Requirements Parser
 *   RFQ application layer -> lib/runtime -> lib/state-machine -> Supabase
 *
 * This file owns input validation, the create/read data access calls (via
 * the injected RfqDbClient port, db.ts), invoking the injected
 * RequirementsParser, and mapping RfqRow -> Rfq. It does NOT own a
 * transition table, does NOT duplicate lib/state-machine's lifecycle rules,
 * does NOT implement its own parsing logic (that lives entirely in
 * requirements-parser.ts), and NEVER issues `supabase.from("rfqs").update({
 * status: ...})` itself -- every status change, including
 * processRfqRequirements()'s CREATED -> PROCESSING transition, is a
 * lib/runtime AppEvent dispatched through the injected StateRuntime,
 * exactly as Phase 3 established.
 *
 * createRfqApplication() takes its dependencies by injection (an
 * RfqDbClient, a StateRuntime, and a RequirementsParser), the same DI
 * pattern createStateRuntime() (lib/runtime/state-runtime.ts) already
 * established -- so this layer is unit-testable against fakes/the real
 * deterministic parser, with no live Supabase connection (see
 * application.test.ts). createSupabaseRfqApplication() below is the
 * convenience factory real application code calls to get one backed by the
 * live database and this phase's deterministic parser.
 */

import type { StateRuntime } from "../runtime/index.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import { toStatusDbClient } from "../runtime/supabase-status-db.ts";
import { createStateRuntime } from "../runtime/state-runtime.ts";
import { RfqNotFoundError, RfqPersistenceError, RfqValidationError } from "./errors.ts";
import type { RfqDbClient, RfqRow } from "./db.ts";
import { toRfqDbClient } from "./supabase-rfq-db.ts";
import type { CreateRfqInput, Rfq } from "./types.ts";
import type { RfqTransitionEvent } from "../runtime/events.ts";
import {
  createDeterministicRequirementsParser,
  type RequirementsParser,
} from "./requirements-parser.ts";

/**
 * Everything transitionRfqStatus() needs, mirroring lib/runtime's
 * RfqTransitionEvent minus the `type` discriminant createRfqApplication()
 * supplies itself -- so the field list is derived, not re-typed a third
 * time (RfqTransitionEvent is itself already derived from
 * lib/state-machine's TransitionRfqParams -- see lib/runtime/events.ts).
 */
export type TransitionRfqStatusInput = Omit<RfqTransitionEvent, "type">;

export interface RfqApplicationDeps {
  db: RfqDbClient;
  runtime: StateRuntime;
  /**
   * Converts raw_request into structured requirements for
   * processRfqRequirements() below. Injected, not imported directly, so a
   * future LLM-backed RequirementsParser is a pure substitution here --
   * createSupabaseRfqApplication() below is the only place that chooses the
   * concrete (currently deterministic) implementation. Required, like `db`
   * and `runtime`, rather than an optional collaborator with a runtime
   * undefined-check: this codebase's existing DI style (StateRuntime,
   * RfqDbClient) has no precedent for an optional required-collaborator, and
   * the deterministic implementation is pure/synchronous/dependency-free,
   * so there is no real cost to always supplying one (including in tests).
   */
  parser: RequirementsParser;
}

export interface RfqApplication {
  /**
   * Validates `input`, inserts the row, and returns it. Does not go
   * through lib/runtime: CREATED has no incoming edge in RFQ_TRANSITIONS
   * (lib/state-machine/rfq.ts) -- it is never a transition target, only the
   * schema's own `status default 'CREATED'`
   * (supabase/migrations/20260901120003_create_core_tables.sql). This
   * preserves that design rather than routing a non-transition through the
   * transition boundary.
   */
  createRfq(input: CreateRfqInput): Promise<Rfq>;
  /** Throws RfqNotFoundError (not a null return) when no row matches `rfqId`. */
  getRfqById(rfqId: string): Promise<Rfq>;
  /**
   * Dispatches an RFQ_TRANSITION event through lib/runtime and returns the
   * RFQ's fresh state. lib/state-machine remains the sole authority on
   * whether the edge is valid -- this function adds no RFQ-specific
   * transition rule of its own, because none is required beyond what Phase
   * 2 already owns (RFQ_TRANSITIONS, independence from Order/Payment,
   * terminal-state guards); inventing one here would duplicate or
   * second-guess that authority. Errors
   * (InvalidTransitionError/StaleTransitionError/TransitionPersistenceError/
   * AuditWriteError) propagate unchanged from lib/runtime/lib/state-machine.
   */
  transitionRfqStatus(params: TransitionRfqStatusInput): Promise<Rfq>;
  /**
   * Parses `rfq.raw_request` and moves the RFQ from CREATED to PROCESSING,
   * persisting the parsed result into structured_requirements atomically
   * with that same transition (via TransitionRfqParams.structuredRequirements
   * -- lib/state-machine/rfq.ts -- so there is no state where the database
   * shows PROCESSING with structured_requirements still null). The SYSTEM
   * actor type is used because this is a deterministic backend operation,
   * not a buyer, human-merchant, or agent action.
   *
   * Throws RfqNotFoundError if `rfqId` does not exist,
   * RfqRequirementsParsingError if the parser cannot determine the required
   * fields, and otherwise whatever lib/runtime/lib/state-machine throws for
   * an invalid or stale CREATED -> PROCESSING transition
   * (InvalidTransitionError, StaleTransitionError,
   * TransitionPersistenceError, AuditWriteError) -- all propagated
   * unchanged, exactly like transitionRfqStatus() above.
   */
  processRfqRequirements(rfqId: string): Promise<Rfq>;
}

function mapRfqRow(row: RfqRow): Rfq {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    buyerId: row.buyer_id,
    rawRequest: row.raw_request,
    structuredRequirements: row.structured_requirements,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Application-level input validation -- distinct from and in addition to
 * the database's own NOT NULL/FK constraints, which still apply and
 * surface as RfqPersistenceError if violated (e.g. an unknown
 * merchantId/buyerId). Deliberately minimal (AGENTS.md section 11: "Avoid
 * ... Overengineering before MVP functionality exists"): only what
 * DATABASE.md section 8 actually requires, plus one genuinely RFQ-specific
 * rule (an expiresAt already in the past is not a meaningful expiry).
 */
function validateCreateRfqInput(input: CreateRfqInput): void {
  if (typeof input.merchantId !== "string" || input.merchantId.trim() === "") {
    throw new RfqValidationError("merchantId", "is required");
  }
  if (typeof input.buyerId !== "string" || input.buyerId.trim() === "") {
    throw new RfqValidationError("buyerId", "is required");
  }
  if (typeof input.rawRequest !== "string" || input.rawRequest.trim() === "") {
    throw new RfqValidationError("rawRequest", "is required");
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new RfqValidationError("expiresAt", "must be a valid ISO 8601 date string");
    }
    if (parsed.getTime() <= Date.now()) {
      throw new RfqValidationError("expiresAt", "must be in the future");
    }
  }
}

export function createRfqApplication(deps: RfqApplicationDeps): RfqApplication {
  const { db, runtime, parser } = deps;

  async function createRfq(input: CreateRfqInput): Promise<Rfq> {
    validateCreateRfqInput(input);

    const { data, error } = await db.insertRfq({
      merchant_id: input.merchantId,
      buyer_id: input.buyerId,
      raw_request: input.rawRequest,
      expires_at: input.expiresAt ?? null,
    });

    if (error) {
      throw new RfqPersistenceError("insert", error.message);
    }
    if (!data) {
      // Defensive: a successful insert-and-select-one should always return
      // the row. Treated as a persistence error, not silently ignored.
      throw new RfqPersistenceError("insert", "insert reported success but returned no row");
    }

    return mapRfqRow(data);
  }

  async function getRfqById(rfqId: string): Promise<Rfq> {
    const { data, error } = await db.getRfqById(rfqId);

    if (error) {
      throw new RfqPersistenceError("select", error.message);
    }
    if (!data) {
      throw new RfqNotFoundError(rfqId);
    }

    return mapRfqRow(data);
  }

  async function transitionRfqStatus(params: TransitionRfqStatusInput): Promise<Rfq> {
    await runtime.dispatch({ type: "RFQ_TRANSITION", ...params });
    // dispatch() intentionally returns only {entity, id, status} (see
    // state-runtime.ts) rather than re-reading the row itself. This layer
    // re-fetches so every RfqApplication method returns the same full Rfq
    // shape, instead of transitionRfqStatus() alone returning a partial one.
    return getRfqById(params.rfqId);
  }

  async function processRfqRequirements(rfqId: string): Promise<Rfq> {
    const rfq = await getRfqById(rfqId);

    const parsed = await parser.parse(rfq.rawRequest);

    await runtime.dispatch({
      type: "RFQ_TRANSITION",
      rfqId,
      from: "CREATED",
      to: "PROCESSING",
      merchantId: rfq.merchantId,
      buyerId: rfq.buyerId,
      actorType: "SYSTEM",
      // ParsedRfqRequirements is a closed interface (named fields, no index
      // signature), so TS considers it insufficiently overlapping with
      // TransitionRfqParams's `Record<string, unknown> | null` for a direct
      // cast, even though every one of its property types is trivially
      // assignable to `unknown` -- the same reasoning
      // application.test.ts's rfqDbFromStatusDb() already relies on for its
      // own FakeRow -> RfqRow bridge. Safe: this only widens the type used
      // to describe the same object for the JSONB column write; it does not
      // change what value is persisted.
      structuredRequirements: parsed as unknown as Record<string, unknown>,
      inputSummary: rfq.rawRequest,
      outputSummary: `Parsed requirements: quantity=${parsed.quantity}, product=${parsed.product}`,
    });

    // Re-fetch for the same reason transitionRfqStatus() does: dispatch()
    // returns only {entity, id, status}, and every RfqApplication method
    // should return the same full Rfq shape (this one now including the
    // structured_requirements that were just persisted).
    return getRfqById(rfqId);
  }

  return { createRfq, getRfqById, transitionRfqStatus, processRfqRequirements };
}

/**
 * Convenience factory for real application code: an RfqApplication backed
 * by the live database. Reuses the existing service-role client factory
 * (lib/supabase/server.ts) -- no second Supabase client factory is
 * introduced -- and reuses lib/runtime's own toStatusDbClient() adapter for
 * the StateRuntime half, so the transition path goes through the exact
 * same wiring Phase 3 already verified.
 */
export function createSupabaseRfqApplication(): RfqApplication {
  const supabase = createServiceRoleClient();
  return createRfqApplication({
    db: toRfqDbClient(supabase),
    runtime: createStateRuntime(toStatusDbClient(supabase)),
    parser: createDeterministicRequirementsParser(),
  });
}

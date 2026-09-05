/**
 * The Approval application/domain layer. This is the ONLY module the rest
 * of the application should import to create, read, or transition an
 * Approval.
 *
 * Dependency direction (mirrors lib/order/application.ts):
 *   Approval application layer -> lib/runtime -> lib/state-machine -> Supabase
 *
 * This file owns input validation, the create/read data access calls (via
 * the injected ApprovalDbClient port, db.ts), the Quote-reference check
 * createApproval() requires, and mapping ApprovalRow -> Approval. It does
 * NOT own a transition table, does NOT duplicate lib/state-machine's
 * APPROVAL_TRANSITIONS, and NEVER issues
 * `supabase.from("approvals").update({status: ...})` itself -- every status
 * change goes through lib/runtime's dispatch(), exactly as
 * lib/order/application.ts already established.
 *
 * *** Who may call transitionApprovalStatus() ***
 * This function exists so a future, explicitly human-facing surface (a
 * Phase 10 merchant-approval UI/API route -- see the Phase 9 final report's
 * "Remaining work for Phase 10" section) has a typed, policy-respecting way
 * to resolve an Approval, mirroring how every other application layer
 * exposes its full create/read/transition surface symmetrically. It is
 * NOT called anywhere inside lib/agent. The Agent tool registry
 * (lib/agent/tools.ts) intentionally defines no tool that reaches this
 * function -- Phase 9 Step 10's "Do NOT allow self-approval" boundary is
 * enforced by that omission, not by a runtime check inside this file (a
 * capability that is never wired to any tool cannot be invoked by an
 * agent, self-approving or otherwise). See lib/agent/tools.test.ts's
 * boundary-integrity suite for the test that proves the tool registry
 * never exposes this capability.
 *
 * createApprovalApplication() takes its dependencies by injection (an
 * ApprovalDbClient and a StateRuntime), the same DI pattern every other
 * layer uses -- unit-testable against fakes, no live Supabase connection
 * (see application.test.ts). createSupabaseApprovalApplication() below is
 * the convenience factory real application code calls to get one backed by
 * the live database.
 */

import type { StateRuntime } from "../runtime/index.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import { toStatusDbClient } from "../runtime/supabase-status-db.ts";
import { createStateRuntime } from "../runtime/state-runtime.ts";
import {
  ApprovalNotFoundError,
  ApprovalPersistenceError,
  ApprovalQuoteNotFoundError,
  ApprovalValidationError,
} from "./errors.ts";
import type { ApprovalDbClient, ApprovalRow } from "./db.ts";
import { toApprovalDbClient } from "./supabase-approval-db.ts";
import type { Approval, CreateApprovalInput } from "./types.ts";
import type { ApprovalTransitionEvent } from "../runtime/events.ts";

/**
 * Everything transitionApprovalStatus() needs, mirroring lib/runtime's
 * ApprovalTransitionEvent minus the `type` discriminant
 * createApprovalApplication() supplies itself -- same derivation
 * lib/order/application.ts's TransitionOrderStatusInput uses.
 */
export type TransitionApprovalStatusInput = Omit<ApprovalTransitionEvent, "type">;

export interface ApprovalApplicationDeps {
  db: ApprovalDbClient;
  runtime: StateRuntime;
}

export interface ApprovalApplication {
  /**
   * Validates `input`, verifies the referenced Quote exists, inserts the
   * row deriving merchant_id/rfq_id/requested_amount from the Quote (see
   * types.ts's doc comment on CreateApprovalInput for why the amount is
   * never caller-supplied), and returns it. Does not go through
   * lib/runtime: PENDING has no incoming edge in APPROVAL_TRANSITIONS
   * (lib/state-machine/approval.ts) -- it is never a transition target,
   * only the schema's own `status default 'PENDING'`, exactly as
   * createOrder() preserves CREATED's non-transition default.
   */
  createApproval(input: CreateApprovalInput): Promise<Approval>;
  /** Throws ApprovalNotFoundError (not a null return) when no row matches `approvalId`. */
  getApprovalById(approvalId: string): Promise<Approval>;
  /**
   * Reads the most recently created Approval for a given quoteId, or `null`
   * if none exists yet. Read-only, no lib/runtime involvement.
   */
  getLatestApprovalByQuoteId(quoteId: string): Promise<Approval | null>;
  /**
   * Dispatches an APPROVAL_TRANSITION event through lib/runtime and returns
   * the Approval's fresh state. lib/state-machine remains the sole
   * authority on whether the edge is valid. See this file's doc comment
   * above for exactly who is expected to call this (not lib/agent).
   */
  transitionApprovalStatus(params: TransitionApprovalStatusInput): Promise<Approval>;
}

function mapApprovalRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    rfqId: row.rfq_id,
    quoteId: row.quote_id,
    requestedAmount: row.requested_amount,
    reason: row.reason,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

/**
 * Application-level input validation -- distinct from and in addition to
 * the database's own NOT NULL/CHECK constraints, mirroring
 * lib/order/application.ts's validateCreateOrderInput.
 */
function validateCreateApprovalInput(input: CreateApprovalInput): void {
  if (typeof input.quoteId !== "string" || input.quoteId.trim() === "") {
    throw new ApprovalValidationError("quoteId", "is required");
  }
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new ApprovalValidationError("reason", "is required");
  }
}

export function createApprovalApplication(deps: ApprovalApplicationDeps): ApprovalApplication {
  const { db, runtime } = deps;

  async function getApprovalById(approvalId: string): Promise<Approval> {
    const { data, error } = await db.getApprovalById(approvalId);

    if (error) {
      throw new ApprovalPersistenceError("select", error.message);
    }
    if (!data) {
      throw new ApprovalNotFoundError(approvalId);
    }

    return mapApprovalRow(data);
  }

  async function getLatestApprovalByQuoteId(quoteId: string): Promise<Approval | null> {
    const { data, error } = await db.getLatestApprovalByQuoteId(quoteId);

    if (error) {
      throw new ApprovalPersistenceError("select-latest", error.message);
    }
    if (!data) {
      return null;
    }

    return mapApprovalRow(data);
  }

  async function createApproval(input: CreateApprovalInput): Promise<Approval> {
    validateCreateApprovalInput(input);

    const { data: quoteRef, error: quoteError } = await db.getQuoteRef(input.quoteId);
    if (quoteError) {
      throw new ApprovalPersistenceError("select-quote", quoteError.message);
    }
    if (!quoteRef) {
      throw new ApprovalQuoteNotFoundError(input.quoteId);
    }

    const { data, error } = await db.insertApproval({
      merchant_id: quoteRef.merchant_id,
      rfq_id: quoteRef.rfq_id,
      quote_id: quoteRef.id,
      requested_amount: quoteRef.total_amount,
      reason: input.reason,
    });

    if (error) {
      throw new ApprovalPersistenceError("insert", error.message);
    }
    if (!data) {
      // Defensive: a successful insert-and-select-one should always return
      // the row. Treated as a persistence error, not silently ignored.
      throw new ApprovalPersistenceError("insert", "insert reported success but returned no row");
    }

    return mapApprovalRow(data);
  }

  async function transitionApprovalStatus(params: TransitionApprovalStatusInput): Promise<Approval> {
    await runtime.dispatch({ type: "APPROVAL_TRANSITION", ...params });
    return getApprovalById(params.approvalId);
  }

  return { createApproval, getApprovalById, getLatestApprovalByQuoteId, transitionApprovalStatus };
}

/**
 * Convenience factory for real application code: an ApprovalApplication
 * backed by the live database. Constructed fresh per call, never at module
 * scope, matching every other layer's createSupabaseXApplication()
 * convention.
 */
export function createSupabaseApprovalApplication(): ApprovalApplication {
  const supabase = createServiceRoleClient();
  return createApprovalApplication({
    db: toApprovalDbClient(supabase),
    runtime: createStateRuntime(toStatusDbClient(supabase)),
  });
}

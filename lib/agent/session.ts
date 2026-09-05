/**
 * The Agent Session application/domain layer. This is the ONLY module the
 * rest of the application should import to create, read, or transition an
 * Agent Session.
 *
 * Dependency direction (mirrors lib/approval/application.ts):
 *   Agent Session application layer -> lib/runtime -> lib/state-machine -> Supabase
 *
 * This file owns input validation, the create/read data access calls (via
 * the injected AgentSessionDbClient port, db.ts), the Rfq-reference check
 * createSession() requires, and mapping AgentSessionRow -> AgentSession. It
 * does NOT own a transition table -- AGENT_SESSION_TRANSITIONS already
 * exists in lib/state-machine/agent-session.ts, built in an earlier phase --
 * and NEVER issues `supabase.from("agent_sessions").update({status: ...})`
 * itself: every status change goes through lib/runtime's dispatch(), the
 * same discipline every other application layer in this codebase already
 * follows. Zero lib/runtime/lib/state-machine changes were needed to write
 * this file: AgentSessionTransitionEvent and its dispatch() switch case
 * were already fully implemented before this phase.
 *
 * createAgentSessionApplication() takes its dependencies by injection (an
 * AgentSessionDbClient and a StateRuntime), the same DI pattern every other
 * layer uses -- unit-testable against fakes, no live Supabase connection
 * (see session.test.ts). createSupabaseAgentSessionApplication() below is
 * the convenience factory real application code calls to get one backed by
 * the live database.
 */

import type { StateRuntime } from "../runtime/index.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import { toStatusDbClient } from "../runtime/supabase-status-db.ts";
import { createStateRuntime } from "../runtime/state-runtime.ts";
import {
  AgentSessionNotFoundError,
  AgentSessionPersistenceError,
  AgentSessionRfqNotFoundError,
  AgentSessionValidationError,
} from "./errors.ts";
import type { AgentSessionDbClient, AgentSessionRow } from "./db.ts";
import { toAgentSessionDbClient } from "./supabase-agent-session-db.ts";
import type { AgentSession, CreateAgentSessionInput } from "./types.ts";
import type { AgentSessionTransitionEvent } from "../runtime/events.ts";

/**
 * Everything transitionSession() needs, mirroring lib/runtime's
 * AgentSessionTransitionEvent minus the `type` discriminant
 * createAgentSessionApplication() supplies itself -- same derivation
 * lib/approval/application.ts's TransitionApprovalStatusInput uses.
 */
export type TransitionSessionInput = Omit<AgentSessionTransitionEvent, "type">;

export interface AgentSessionApplicationDeps {
  db: AgentSessionDbClient;
  runtime: StateRuntime;
}

export interface AgentSessionApplication {
  /**
   * Validates `input`, verifies the referenced Rfq exists, inserts the row
   * deriving merchant_id/buyer_id from the Rfq (see types.ts's doc comment
   * on CreateAgentSessionInput for why these are never caller-supplied),
   * always with status "RUNNING" (the column's only valid starting value --
   * see db.ts's doc comment on NewAgentSessionRow for why this is passed
   * explicitly rather than left to a database default), and returns it.
   * Does not go through lib/runtime: RUNNING has no incoming edge in
   * AGENT_SESSION_TRANSITIONS (lib/state-machine/agent-session.ts), so it
   * is never reached by a transition, only by this initial insert.
   */
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>;
  /** Throws AgentSessionNotFoundError (not a null return) when no row matches `sessionId`. */
  getSession(sessionId: string): Promise<AgentSession>;
  /**
   * Dispatches an AGENT_SESSION_TRANSITION event through lib/runtime and
   * returns the session's fresh state. lib/state-machine remains the sole
   * authority on whether the edge is valid (RUNNING -> COMPLETED / FAILED /
   * CANCELLED; every other edge rejected as terminal).
   */
  transitionSession(params: TransitionSessionInput): Promise<AgentSession>;
}

function mapAgentSessionRow(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    buyerId: row.buyer_id,
    rfqId: row.rfq_id,
    sessionType: row.session_type,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/**
 * Application-level input validation -- distinct from and in addition to
 * the database's own NOT NULL/CHECK constraints, mirroring
 * lib/approval/application.ts's validateCreateApprovalInput.
 */
function validateCreateSessionInput(input: CreateAgentSessionInput): void {
  if (typeof input.rfqId !== "string" || input.rfqId.trim() === "") {
    throw new AgentSessionValidationError("rfqId", "is required");
  }
  if (input.sessionType !== "SELLER_AGENT" && input.sessionType !== "BUYER_AGENT") {
    throw new AgentSessionValidationError("sessionType", "must be SELLER_AGENT or BUYER_AGENT");
  }
}

export function createAgentSessionApplication(
  deps: AgentSessionApplicationDeps,
): AgentSessionApplication {
  const { db, runtime } = deps;

  async function getSession(sessionId: string): Promise<AgentSession> {
    const { data, error } = await db.getAgentSessionById(sessionId);

    if (error) {
      throw new AgentSessionPersistenceError("select", error.message);
    }
    if (!data) {
      throw new AgentSessionNotFoundError(sessionId);
    }

    return mapAgentSessionRow(data);
  }

  async function createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    validateCreateSessionInput(input);

    const { data: rfqRef, error: rfqError } = await db.getRfqRef(input.rfqId);
    if (rfqError) {
      throw new AgentSessionPersistenceError("select-rfq", rfqError.message);
    }
    if (!rfqRef) {
      throw new AgentSessionRfqNotFoundError(input.rfqId);
    }

    const { data, error } = await db.insertAgentSession({
      merchant_id: rfqRef.merchant_id,
      buyer_id: rfqRef.buyer_id,
      rfq_id: rfqRef.id,
      session_type: input.sessionType,
      status: "RUNNING",
    });

    if (error) {
      throw new AgentSessionPersistenceError("insert", error.message);
    }
    if (!data) {
      // Defensive: a successful insert-and-select-one should always return
      // the row. Treated as a persistence error, not silently ignored.
      throw new AgentSessionPersistenceError("insert", "insert reported success but returned no row");
    }

    return mapAgentSessionRow(data);
  }

  async function transitionSession(params: TransitionSessionInput): Promise<AgentSession> {
    await runtime.dispatch({ type: "AGENT_SESSION_TRANSITION", ...params });
    return getSession(params.sessionId);
  }

  return { createSession, getSession, transitionSession };
}

/**
 * Convenience factory for real application code: an AgentSessionApplication
 * backed by the live database. Constructed fresh per call, never at module
 * scope, matching every other layer's createSupabaseXApplication()
 * convention.
 */
export function createSupabaseAgentSessionApplication(): AgentSessionApplication {
  const supabase = createServiceRoleClient();
  return createAgentSessionApplication({
    db: toAgentSessionDbClient(supabase),
    runtime: createStateRuntime(toStatusDbClient(supabase)),
  });
}

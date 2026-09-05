/**
 * The Agent Session application layer's own narrow data-access port --
 * mirrors lib/approval/db.ts's pattern exactly, including not depending on
 * lib/rfq (this layer reads the handful of Rfq fields it needs -- id,
 * merchant_id, buyer_id -- directly, for the same reason every other db.ts
 * in this codebase gives: pulling in the whole RfqApplication for one
 * narrow read would be a heavier, more indirect dependency).
 *
 * PostgrestResult is reused from lib/state-machine rather than redeclared,
 * same as every other layer's db.ts.
 */

import type { PostgrestResult } from "../state-machine/index.ts";
import type { AgentSessionStatus } from "../state-machine/index.ts";
import type { AgentSessionType } from "./types.ts";

/** The raw agent_sessions row shape, snake_case, exactly as Postgres/PostgREST returns it. */
export interface AgentSessionRow {
  id: string;
  merchant_id: string;
  buyer_id: string;
  rfq_id: string;
  session_type: AgentSessionType;
  status: AgentSessionStatus;
  started_at: string;
  ended_at: string | null;
}

/**
 * Columns createSession() may set on insert. Unlike every other entity's
 * NewXRow, `status` IS included here: the agent_sessions.status column has
 * no database default (supabase/migrations/20260901140000_
 * add_agent_session_status_enum.sql says so explicitly -- "No default is
 * introduced here: the column was NOT NULL with no default before this
 * migration"), so the application layer must supply an initial value on
 * every insert. session.ts always passes the literal "RUNNING" -- the only
 * state with no incoming edge in AGENT_SESSION_TRANSITIONS, i.e. the only
 * valid starting state -- never a caller-supplied value.
 */
export interface NewAgentSessionRow {
  merchant_id: string;
  buyer_id: string;
  rfq_id: string;
  session_type: AgentSessionType;
  status: AgentSessionStatus;
}

/**
 * The minimal Rfq fields createSession() needs to validate the reference
 * and derive merchant_id/buyer_id -- not lib/rfq's own Rfq type, mirroring
 * lib/approval/db.ts's QuoteRefRow.
 */
export interface RfqRefRow {
  id: string;
  merchant_id: string;
  buyer_id: string;
}

/**
 * The only database operations the Agent Session application layer needs.
 * Narrow and purpose-built, mirroring ApprovalDbClient.
 */
export interface AgentSessionDbClient {
  /** Inserts one agent_sessions row and returns it as the database actually stored it. */
  insertAgentSession(row: NewAgentSessionRow): PromiseLike<PostgrestResult<AgentSessionRow>>;
  /** Reads one agent_sessions row by id. `data: null` (with `error: null`) means "no such row". */
  getAgentSessionById(id: string): PromiseLike<PostgrestResult<AgentSessionRow>>;
  /** Reads the minimal Rfq fields needed to validate a createSession() reference. */
  getRfqRef(rfqId: string): PromiseLike<PostgrestResult<RfqRefRow>>;
}

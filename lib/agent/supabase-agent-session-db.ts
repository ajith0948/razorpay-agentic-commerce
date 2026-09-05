/**
 * Adapts a real @supabase/supabase-js client to AgentSessionDbClient (db.ts)
 * -- the Agent Session-layer analog of lib/approval/supabase-approval-db.ts's
 * toApprovalDbClient().
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentSessionDbClient } from "./db.ts";

const AGENT_SESSIONS_TABLE = "agent_sessions";
const RFQS_TABLE = "rfqs";

export function toAgentSessionDbClient(supabase: SupabaseClient) {
  const client: AgentSessionDbClient = {
    insertAgentSession: (row) => supabase.from(AGENT_SESSIONS_TABLE).insert(row).select().single(),
    getAgentSessionById: (id) =>
      supabase.from(AGENT_SESSIONS_TABLE).select("*").eq("id", id).maybeSingle(),
    getRfqRef: (rfqId) =>
      supabase.from(RFQS_TABLE).select("id, merchant_id, buyer_id").eq("id", rfqId).maybeSingle(),
  };
  return client;
}

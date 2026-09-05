/**
 * Adapts a real @supabase/supabase-js client to ApprovalDbClient (db.ts) --
 * the Approval-layer analog of lib/order/supabase-order-db.ts's
 * toOrderDbClient().
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApprovalDbClient } from "./db.ts";

const APPROVALS_TABLE = "approvals";
const QUOTES_TABLE = "quotes";

export function toApprovalDbClient(supabase: SupabaseClient) {
  const client: ApprovalDbClient = {
    insertApproval: (row) => supabase.from(APPROVALS_TABLE).insert(row).select().single(),
    getApprovalById: (id) => supabase.from(APPROVALS_TABLE).select("*").eq("id", id).maybeSingle(),
    getQuoteRef: (quoteId) =>
      supabase.from(QUOTES_TABLE).select("id, merchant_id, rfq_id, total_amount").eq("id", quoteId).maybeSingle(),
    getLatestApprovalByQuoteId: (quoteId) =>
      supabase
        .from(APPROVALS_TABLE)
        .select("*")
        .eq("quote_id", quoteId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
  };
  return client;
}

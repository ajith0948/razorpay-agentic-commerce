/**
 * Adapts a real @supabase/supabase-js client to RfqDbClient (db.ts) --
 * the RFQ-layer analog of lib/runtime/supabase-status-db.ts's
 * toStatusDbClient(). Unlike that function, this one is not a structural
 * passthrough: RfqDbClient's two operations (insertRfq/getRfqById) don't
 * exist verbatim on SupabaseClient, they're each a specific
 * `.from("rfqs")...` call chain, so there is real (if small) wiring code
 * here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RfqDbClient } from "./db.ts";

const TABLE = "rfqs";

export function toRfqDbClient(supabase: SupabaseClient) {
  const client: RfqDbClient = {
    insertRfq: (row) => supabase.from(TABLE).insert(row).select().single(),
    getRfqById: (id) => supabase.from(TABLE).select("*").eq("id", id).maybeSingle(),
  };
  return client;
}

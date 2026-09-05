/**
 * Adapts a real @supabase/supabase-js client to OrderDbClient (db.ts) --
 * the Order-layer analog of lib/quote/supabase-quote-db.ts's
 * toQuoteDbClient().
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderDbClient } from "./db.ts";

const ORDERS_TABLE = "orders";
const QUOTES_TABLE = "quotes";

export function toOrderDbClient(supabase: SupabaseClient) {
  const client: OrderDbClient = {
    insertOrder: (row) => supabase.from(ORDERS_TABLE).insert(row).select().single(),
    getOrderById: (id) => supabase.from(ORDERS_TABLE).select("*").eq("id", id).maybeSingle(),
    getQuoteRef: (quoteId) =>
      supabase
        .from(QUOTES_TABLE)
        .select("id, merchant_id, buyer_id, rfq_id, total_amount, currency, status")
        .eq("id", quoteId)
        .maybeSingle(),
    getOrderByQuoteId: (quoteId) =>
      supabase.from(ORDERS_TABLE).select("*").eq("quote_id", quoteId).maybeSingle(),
  };
  return client;
}

/**
 * Adapts a real @supabase/supabase-js client to QuoteDbClient (db.ts) --
 * the Quote-layer analog of lib/rfq/supabase-rfq-db.ts's toRfqDbClient().
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { QuoteDbClient } from "./db.ts";

const QUOTES_TABLE = "quotes";
const RFQS_TABLE = "rfqs";
const MERCHANT_POLICIES_TABLE = "merchant_policies";

export function toQuoteDbClient(supabase: SupabaseClient) {
  const client: QuoteDbClient = {
    insertQuote: (row) => supabase.from(QUOTES_TABLE).insert(row).select().single(),
    getQuoteById: (id) => supabase.from(QUOTES_TABLE).select("*").eq("id", id).maybeSingle(),
    getRfqRef: (rfqId) =>
      supabase.from(RFQS_TABLE).select("id, merchant_id, buyer_id, status").eq("id", rfqId).maybeSingle(),
    getActiveMerchantPolicy: (merchantId) =>
      supabase
        .from(MERCHANT_POLICIES_TABLE)
        .select("max_discount_percent")
        .eq("merchant_id", merchantId)
        .eq("active", true)
        .maybeSingle(),
  };
  return client;
}

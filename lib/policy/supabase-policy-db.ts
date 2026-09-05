/**
 * Adapts a real @supabase/supabase-js client to PolicyDbClient (db.ts) --
 * the Policy-layer analog of lib/order/supabase-order-db.ts's
 * toOrderDbClient(). Query shape mirrors lib/quote/supabase-quote-db.ts's
 * own `.eq("merchant_id", ...).eq("active", true).maybeSingle()` lookup of
 * this exact table.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PolicyDbClient } from "./db.ts";

const MERCHANT_POLICIES_TABLE = "merchant_policies";

export function toPolicyDbClient(supabase: SupabaseClient) {
  const client: PolicyDbClient = {
    getActiveMerchantPolicy: (merchantId) =>
      supabase
        .from(MERCHANT_POLICIES_TABLE)
        .select("*")
        .eq("merchant_id", merchantId)
        .eq("active", true)
        .maybeSingle(),
  };
  return client;
}

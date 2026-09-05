/**
 * Adapts a real @supabase/supabase-js client to PaymentDbClient (db.ts) --
 * the Payment-layer analog of lib/order/supabase-order-db.ts's
 * toOrderDbClient().
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaymentDbClient } from "./db.ts";

const PAYMENTS_TABLE = "payments";
const ORDERS_TABLE = "orders";

export function toPaymentDbClient(supabase: SupabaseClient) {
  const client: PaymentDbClient = {
    insertPayment: (row) => supabase.from(PAYMENTS_TABLE).insert(row).select().single(),
    getPaymentById: (id) => supabase.from(PAYMENTS_TABLE).select("*").eq("id", id).maybeSingle(),
    getOrderRef: (orderId) =>
      supabase
        .from(ORDERS_TABLE)
        .select("id, quote_id, total_amount, currency, status")
        .eq("id", orderId)
        .maybeSingle(),
  };
  return client;
}

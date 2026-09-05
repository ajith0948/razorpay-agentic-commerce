/**
 * Order state machine -- DATABASE.md section 14.
 *
 * CREATED -> PAYMENT_PENDING -> PAID -> CONFIRMED is the success path;
 * PAYMENT_PENDING -> PAYMENT_FAILED and CREATED -> CANCELLED are the only
 * documented failure/cancellation edges. A failed payment does not send the
 * order status back to PAYMENT_PENDING for a retry: section 14 is explicit
 * that retries happen by creating a *new* Payment row against the same
 * order (Payment.order_id is the only link, precisely so multiple attempts
 * can exist), not by moving Order.status backward. So PAYMENT_FAILED has no
 * outgoing edges here.
 *
 * Order state is independent of RFQ state (section 14's own rule, mirrored
 * in section 9): this module never reads or writes rfqs.status, and rfq.ts
 * never reads or writes orders.status.
 */

import { assertValidTransition, type TransitionTable } from "./transition-table.ts";
import { applyStatusTransition, type StatusDbClient } from "./db.ts";
import { recordAuditEvent } from "./audit.ts";
import { OrderPaymentNotVerifiedError, TransitionPersistenceError } from "./errors.ts";
import type { AuditActorType, OrderStatus } from "./types.ts";

export const ORDER_TRANSITIONS: TransitionTable<OrderStatus> = {
  CREATED: ["PAYMENT_PENDING", "CANCELLED"],
  PAYMENT_PENDING: ["PAID", "PAYMENT_FAILED"],
  // PAID's only outgoing edge is CONFIRMED. This is also what guarantees
  // "an already-PAID order cannot return to PAYMENT_PENDING": there is no
  // edge from PAID back to PAYMENT_PENDING, or anywhere except CONFIRMED.
  PAID: ["CONFIRMED"],
  CONFIRMED: [],
  PAYMENT_FAILED: [],
  CANCELLED: [],
};

/**
 * Statuses an order may only reach if a Payment row for it has genuinely
 * reached PAID (i.e. via markPaymentPaid(), which itself requires verified
 * Razorpay evidence -- see payment.ts). The literal task requirement was
 * "Order cannot become CONFIRMED unless its payment is actually considered
 * PAID"; this deliberately also gates the PAID transition itself, one step
 * earlier than strictly asked. Reasoning: if PAYMENT_PENDING -> PAID were
 * left ungated, an order could reach Order.status = PAID with no backing
 * Payment row at all, and the later PAID -> CONFIRMED check -- which only
 * asks "is there a PAID payment for this order?" -- would already be
 * trivially satisfied by that same unverified state. Gating both is the
 * reading consistent with AGENTS.md section 6's blanket rule that payment
 * success must always be backend-verified, not merely checked once
 * somewhere downstream. Flagged in the Phase 2 report as an interpretive
 * extension beyond the literal spec.
 */
const ORDER_STATES_REQUIRING_VERIFIED_PAYMENT: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "PAID",
  "CONFIRMED",
]);

/**
 * True if at least one payments row for this order has status PAID.
 * payments_one_paid_per_order_idx (supabase/migrations/
 * 20260901120005_payment_invariant.sql) guarantees there is never more than
 * one, so "exists" and "is unique" coincide -- this only needs an
 * existence check, not a specific row.
 */
async function hasVerifiedPaidPayment(client: StatusDbClient, orderId: string): Promise<boolean> {
  const { data, error } = await client
    .from("payments")
    .select("id")
    .eq("order_id", orderId)
    .eq("status", "PAID")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new TransitionPersistenceError("payments", orderId, error.message);
  }
  return data !== null;
}

/** event_type per edge, per ARCHITECTURE.md section 21's example list. */
function orderEventType(to: OrderStatus): string {
  if (to === "CONFIRMED") return "ORDER_CONFIRMED";
  return "ORDER_STATUS_CHANGED";
}

export interface TransitionOrderParams {
  client: StatusDbClient;
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
  /** Required: audit_events.merchant_id is NOT NULL. */
  merchantId: string;
  actorType: AuditActorType;
  buyerId?: string | null;
  rfqId?: string | null;
  quoteId?: string | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
  policyResult?: string | null;
}

/**
 * The only way application code may change an Order's status. Reaching
 * PAID or CONFIRMED additionally requires a Payment row for this order to
 * have already reached PAID (see ORDER_STATES_REQUIRING_VERIFIED_PAYMENT
 * above) -- throws OrderPaymentNotVerifiedError otherwise, even when the
 * requested edge is otherwise valid in ORDER_TRANSITIONS.
 */
export async function transitionOrder(params: TransitionOrderParams): Promise<void> {
  const {
    client,
    orderId,
    from,
    to,
    merchantId,
    actorType,
    buyerId,
    rfqId,
    quoteId,
    inputSummary,
    outputSummary,
    policyResult,
  } = params;

  assertValidTransition("Order", ORDER_TRANSITIONS, from, to);

  if (ORDER_STATES_REQUIRING_VERIFIED_PAYMENT.has(to)) {
    const verified = await hasVerifiedPaidPayment(client, orderId);
    if (!verified) {
      throw new OrderPaymentNotVerifiedError(orderId, to);
    }
  }

  await applyStatusTransition({ client, table: "orders", id: orderId, from, to });

  await recordAuditEvent(client, {
    merchantId,
    buyerId,
    rfqId,
    quoteId,
    orderId,
    eventType: orderEventType(to),
    actorType,
    action: `Order status changed: ${from} -> ${to}`,
    inputSummary,
    outputSummary,
    policyResult,
  });
}

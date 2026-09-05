/**
 * Pure "purchase progress" derivation for the buyer's primary AI Purchasing
 * Assistant view (post-Phase-12 demo-UX pass, PART 2).
 *
 * Turns real backend status values (Rfq.status, Order.status, and whether
 * the agent is currently stopped waiting on a create_payment approval) into
 * a fixed five-item checklist -- Request, Quote, Approval, Order, Payment --
 * each with a human-friendly `detail` string. Same separation
 * lib/ui/format.ts and lib/ui/agent-conversation.ts already establish: no
 * `fetch`, no React, no commerce/business logic of its own. This file only
 * *labels* state that already exists; it never invents a status or decides a
 * transition.
 *
 * IMPORTANT -- this is a checklist, not a strict linear wizard. In the real
 * backend, "Approval" only ever gates create_payment (see
 * lib/agent/tools.ts's handleCreatePayment) -- never order creation. So an
 * Order can already be CREATED while Approval is still pending, and both
 * facts are reported truthfully and simultaneously here rather than forcing
 * a strict left-to-right completion order the backend does not actually
 * enforce. The five labels are shown in the order the spec asked for
 * (Request, Quote, Approval, Order, Payment) purely for scannability.
 *
 * Two real limitations, both a consequence of endpoints that genuinely don't
 * exist (see lib/ui/api-client.ts's own doc comments) rather than anything
 * this file works around by inventing data:
 *
 *  - There is no "get quote for this rfq" endpoint, so the Quote stage is
 *    derived from `rfq.status` itself (which already carries QUOTED /
 *    NEGOTIATING / ACCEPTED / REJECTED) and from whether an Order is known
 *    (an Order can only ever be created from an ACCEPTED quote -- see
 *    app/api/orders/route.ts -- so its mere existence is direct proof),
 *    never from a separately-fetched Quote object.
 *  - There is no "get payment for this order" endpoint either, so the
 *    Payment stage is derived from `order.status` (PAYMENT_PENDING / PAID /
 *    CONFIRMED / PAYMENT_FAILED already mirror payment progress at the order
 *    level) rather than a separately-fetched Payment object.
 *
 * Every `detail` string below is chosen only when the real status value it
 * is attached to actually supports that meaning -- never a guess.
 */

import type { Order, Rfq } from "./api-client.ts";

export type PurchaseStageKey = "request" | "quote" | "approval" | "order" | "payment";

/** "blocked" covers every terminal-negative outcome (rejected, expired, cancelled, failed) -- one umbrella state, kept simple for the checklist UI. */
export type PurchaseStageState = "upcoming" | "active" | "done" | "blocked";

export interface PurchaseStage {
  key: PurchaseStageKey;
  label: string;
  state: PurchaseStageState;
  /** Human-friendly, buyer-facing. Never a raw backend status string. */
  detail: string;
}

export interface PurchaseProgressInput {
  rfq: Rfq | null;
  /** Known only once an orderId has surfaced structurally (see extractOrderIdFromToolInput) and been fetched. */
  order: Order | null;
  /** True exactly while the agent is stopped waiting for a human decision on a create_payment call. */
  awaitingPaymentApproval: boolean;
}

export function derivePurchaseProgress(input: PurchaseProgressInput): PurchaseStage[] {
  return [
    deriveRequestStage(input.rfq),
    deriveQuoteStage(input.rfq, input.order),
    deriveApprovalStage(input),
    deriveOrderStage(input.order),
    derivePaymentStage(input.order),
  ];
}

function deriveRequestStage(rfq: Rfq | null): PurchaseStage {
  const label = "Request";
  if (!rfq) {
    return { key: "request", label, state: "upcoming", detail: "Tell the AI what you need to get started." };
  }
  switch (rfq.status) {
    case "CREATED":
      return { key: "request", label, state: "active", detail: "Request received" };
    case "PROCESSING":
      return { key: "request", label, state: "active", detail: "Preparing your request" };
    case "QUOTED":
    case "NEGOTIATING":
    case "ACCEPTED":
    case "REJECTED":
      return { key: "request", label, state: "done", detail: "Request understood" };
    case "EXPIRED":
      return { key: "request", label, state: "blocked", detail: "Request expired" };
    case "CANCELLED":
      return { key: "request", label, state: "blocked", detail: "Request was cancelled" };
    case "FAILED":
      return { key: "request", label, state: "blocked", detail: "We couldn't process this request" };
  }
}

function deriveQuoteStage(rfq: Rfq | null, order: Order | null): PurchaseStage {
  const label = "Quote";
  if (order) {
    // An order can only ever be created from an ACCEPTED quote -- its mere
    // existence is direct proof, independent of rfq.status.
    return { key: "quote", label, state: "done", detail: "Quote accepted" };
  }
  if (!rfq) {
    return { key: "quote", label, state: "upcoming", detail: "Not ready yet" };
  }
  switch (rfq.status) {
    case "CREATED":
    case "PROCESSING":
      return { key: "quote", label, state: "upcoming", detail: "Not ready yet" };
    case "QUOTED":
      return { key: "quote", label, state: "active", detail: "Quote being prepared" };
    case "NEGOTIATING":
      return { key: "quote", label, state: "active", detail: "Negotiating the quote" };
    case "ACCEPTED":
      return { key: "quote", label, state: "done", detail: "Quote accepted" };
    case "REJECTED":
      return { key: "quote", label, state: "blocked", detail: "Quote was rejected" };
    case "EXPIRED":
    case "CANCELLED":
    case "FAILED":
      return { key: "quote", label, state: "blocked", detail: "No quote -- request did not proceed" };
  }
}

function deriveApprovalStage(input: PurchaseProgressInput): PurchaseStage {
  const label = "Approval";
  if (input.awaitingPaymentApproval) {
    return { key: "approval", label, state: "active", detail: "Waiting for manager approval" };
  }
  if (input.order && input.order.status !== "CREATED") {
    // A payment attempt only ever proceeds past order creation once
    // create_payment itself has succeeded -- which requires merchant policy
    // to have allowed it outright, or an approval to already be APPROVED
    // (see lib/agent/tools.ts's handleCreatePayment). Either way this
    // checkpoint is no longer blocking anything.
    return { key: "approval", label, state: "done", detail: "Cleared" };
  }
  return { key: "approval", label, state: "upcoming", detail: "Not needed yet" };
}

function deriveOrderStage(order: Order | null): PurchaseStage {
  const label = "Order";
  if (!order) {
    return { key: "order", label, state: "upcoming", detail: "Not created yet" };
  }
  switch (order.status) {
    case "CREATED":
    case "PAYMENT_PENDING":
    case "PAID":
    case "CONFIRMED":
      return { key: "order", label, state: "done", detail: "Order created" };
    case "PAYMENT_FAILED":
      return { key: "order", label, state: "blocked", detail: "Payment failed for this order" };
    case "CANCELLED":
      return { key: "order", label, state: "blocked", detail: "Order was cancelled" };
  }
}

function derivePaymentStage(order: Order | null): PurchaseStage {
  const label = "Payment";
  if (!order) {
    return { key: "payment", label, state: "upcoming", detail: "Not completed yet" };
  }
  switch (order.status) {
    case "CREATED":
      return { key: "payment", label, state: "upcoming", detail: "Not completed yet" };
    case "PAYMENT_PENDING":
      return { key: "payment", label, state: "active", detail: "Payment not completed yet" };
    case "PAID":
    case "CONFIRMED":
      return { key: "payment", label, state: "done", detail: "Payment verified" };
    case "PAYMENT_FAILED":
      return { key: "payment", label, state: "blocked", detail: "Payment failed" };
    case "CANCELLED":
      return { key: "payment", label, state: "blocked", detail: "Order was cancelled" };
  }
}

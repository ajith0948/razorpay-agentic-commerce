/**
 * Payment state machine -- DATABASE.md section 13.
 *
 * CREATED -> PENDING -> PAID, with PENDING -> FAILED as the failure path.
 * PAID is reachable ONLY through markPaymentPaid(), never through the
 * generic transitionPayment() -- AGENTS.md section 6 / DATABASE.md section
 * 13: "Payment state must be updated from verified Razorpay events" and
 * "Client-side success messages are not the source of truth." Blocking
 * PAID out of the generic function, both at the type level
 * (Exclude<PaymentStatus, "PAID">) and at runtime, makes it structurally
 * impossible for an ordinary caller (an agent tool, an API route reacting
 * to a client request) to slip a PAID status through the same code path
 * used for everyday transitions.
 */

import { assertValidTransition, type TransitionTable } from "./transition-table.ts";
import { applyStatusTransition, type StatusDbClient } from "./db.ts";
import { recordAuditEvent } from "./audit.ts";
import { PaymentPaidRequiresVerificationError } from "./errors.ts";
import type { AuditActorType, PaymentStatus } from "./types.ts";

export const PAYMENT_TRANSITIONS: TransitionTable<PaymentStatus> = {
  CREATED: ["PENDING"],
  PENDING: ["PAID", "FAILED"],
  PAID: [],
  FAILED: [],
};

/**
 * event_type per edge, per ARCHITECTURE.md section 21's example list.
 * PENDING -> FAILED is documented as PAYMENT_FAILED. CREATED -> PENDING has
 * no equally unambiguous name: PAYMENT_CREATED in that list reads as the
 * row-creation moment (status already CREATED at insert time), not this
 * transition, so it falls back to the generic name rather than reusing
 * PAYMENT_CREATED for something the doc did not clearly assign it to.
 */
function paymentEventType(to: Exclude<PaymentStatus, "PAID">): string {
  if (to === "FAILED") return "PAYMENT_FAILED";
  return "PAYMENT_STATUS_CHANGED";
}

export interface TransitionPaymentParams {
  client: StatusDbClient;
  paymentId: string;
  from: PaymentStatus;
  to: Exclude<PaymentStatus, "PAID">;
  /** Required: audit_events.merchant_id is NOT NULL. */
  merchantId: string;
  actorType: AuditActorType;
  orderId?: string | null;
  quoteId?: string | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
  policyResult?: string | null;
}

/**
 * Transitions a payment to any status EXCEPT PAID -- use markPaymentPaid()
 * for that. Throws PaymentPaidRequiresVerificationError if `to` is "PAID"
 * at runtime even though the `Exclude<PaymentStatus, "PAID">` param type
 * already stops a typechecked caller from passing it: this module must not
 * assume every caller (an LLM-driven tool layer included, per AGENTS.md
 * section 6) is typechecked.
 */
export async function transitionPayment(params: TransitionPaymentParams): Promise<void> {
  const {
    client,
    paymentId,
    from,
    to,
    merchantId,
    actorType,
    orderId,
    quoteId,
    inputSummary,
    outputSummary,
    policyResult,
  } = params;

  if ((to as PaymentStatus) === "PAID") {
    throw new PaymentPaidRequiresVerificationError(paymentId);
  }

  assertValidTransition("Payment", PAYMENT_TRANSITIONS, from, to);

  await applyStatusTransition({ client, table: "payments", id: paymentId, from, to });

  await recordAuditEvent(client, {
    merchantId,
    orderId,
    quoteId,
    eventType: paymentEventType(to),
    actorType,
    action: `Payment status changed: ${from} -> ${to}`,
    inputSummary,
    outputSummary,
    policyResult,
  });
}

/**
 * Evidence that Razorpay itself -- not the client -- confirmed this payment
 * succeeded. AGENTS.md section 6: "Payment success must be confirmed
 * through verified Razorpay server-side events/webhooks." This type exists
 * so markPaymentPaid() cannot be called with nothing to substantiate the
 * claim: whatever calls it (a future phase's webhook handler or a
 * server-side status-check tool) must have actually captured Razorpay's own
 * confirmation first and can name where it came from. There is no
 * dedicated database column for this evidence yet (payments has no
 * razorpay_payment_id column -- only razorpay_order_id and
 * razorpay_payment_link_id, per DATABASE.md section 13/the schema), and
 * this phase must not modify migrations to add one, so it is recorded in
 * the resulting audit event's input/output summary instead.
 */
export interface PaymentVerificationEvidence {
  /** Razorpay's identifier for the successful payment. */
  razorpayPaymentId: string;
  /** How this success was confirmed -- never "the client said so". */
  verifiedVia: "RAZORPAY_WEBHOOK" | "RAZORPAY_API_STATUS_CHECK";
}

export interface MarkPaymentPaidParams {
  client: StatusDbClient;
  paymentId: string;
  from: PaymentStatus;
  /** Required: audit_events.merchant_id is NOT NULL. */
  merchantId: string;
  verification: PaymentVerificationEvidence;
  orderId?: string | null;
  quoteId?: string | null;
}

/**
 * The only function in this codebase permitted to move a Payment to PAID.
 * `from` is still validated against PAYMENT_TRANSITIONS (so e.g. a CREATED
 * payment cannot skip straight to PAID; only PENDING -> PAID is a real
 * edge), reusing the exact same table transitionPayment() uses -- the
 * transition *rules* are not duplicated, only the extra verification
 * requirement and the fixed actor differ. `actorType` is fixed to
 * "RAZORPAY" (never caller-supplied) because, by definition, this
 * transition only ever fires in reaction to a verified Razorpay event.
 */
export async function markPaymentPaid(params: MarkPaymentPaidParams): Promise<void> {
  const { client, paymentId, from, merchantId, verification, orderId, quoteId } = params;

  assertValidTransition("Payment", PAYMENT_TRANSITIONS, from, "PAID");

  await applyStatusTransition({ client, table: "payments", id: paymentId, from, to: "PAID" });

  await recordAuditEvent(client, {
    merchantId,
    orderId,
    quoteId,
    eventType: "PAYMENT_CONFIRMED",
    actorType: "RAZORPAY",
    action: `Payment status changed: ${from} -> PAID`,
    inputSummary: `razorpayPaymentId=${verification.razorpayPaymentId}`,
    outputSummary: `verifiedVia=${verification.verifiedVia}`,
  });
}

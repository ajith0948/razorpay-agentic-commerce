/**
 * The application-event vocabulary this runtime boundary accepts.
 *
 * Every variant is a thin, tagged wrapper around one of lib/state-machine's
 * own TransitionXParams / MarkPaymentPaidParams types (minus `client`, which
 * state-runtime.ts supplies itself -- see that file) rather than a
 * redeclared field list. This keeps the state machine's own Phase 2 types as
 * the single source of truth for what each transition needs, per this
 * phase's own instruction: "The Phase 2 state-machine types should remain
 * the source of truth."
 *
 * This is the ONLY vocabulary of state changes the rest of the application
 * can express through this boundary: state-runtime.ts's dispatch() is an
 * exhaustive switch over `type` with no fallthrough to a raw mutation, so
 * there is no way to reach lib/state-machine's transition functions except
 * through one of these named events.
 */

import type {
  MarkPaymentPaidParams,
  TransitionAgentSessionParams,
  TransitionApprovalParams,
  TransitionOrderParams,
  TransitionPaymentParams,
  TransitionQuoteParams,
  TransitionRfqParams,
} from "../state-machine/index.ts";

export interface RfqTransitionEvent extends Omit<TransitionRfqParams, "client"> {
  type: "RFQ_TRANSITION";
}

export interface QuoteTransitionEvent extends Omit<TransitionQuoteParams, "client"> {
  type: "QUOTE_TRANSITION";
}

export interface OrderTransitionEvent extends Omit<TransitionOrderParams, "client"> {
  type: "ORDER_TRANSITION";
}

export interface PaymentTransitionEvent extends Omit<TransitionPaymentParams, "client"> {
  type: "PAYMENT_TRANSITION";
}

/**
 * The only event that can move a Payment to PAID -- mirrors
 * markPaymentPaid() being the only function in lib/state-machine permitted
 * to do so. Kept as its own event type (rather than folded into
 * PaymentTransitionEvent) so that distinction is visible in the event
 * vocabulary itself, not just inside the dispatch implementation.
 */
export interface PaymentMarkPaidEvent extends Omit<MarkPaymentPaidParams, "client"> {
  type: "PAYMENT_MARK_PAID";
}

export interface ApprovalTransitionEvent extends Omit<TransitionApprovalParams, "client"> {
  type: "APPROVAL_TRANSITION";
}

export interface AgentSessionTransitionEvent
  extends Omit<TransitionAgentSessionParams, "client"> {
  type: "AGENT_SESSION_TRANSITION";
}

export type AppEvent =
  | RfqTransitionEvent
  | QuoteTransitionEvent
  | OrderTransitionEvent
  | PaymentTransitionEvent
  | PaymentMarkPaidEvent
  | ApprovalTransitionEvent
  | AgentSessionTransitionEvent;

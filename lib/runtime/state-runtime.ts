/**
 * The runtime integration boundary between the application and
 * lib/state-machine/. This is the ONLY module the rest of the application
 * should import to change any entity's status.
 *
 * StateRuntime exposes exactly one method -- dispatch() -- and nothing else:
 * no accessor for the underlying database client, no per-entity mutation
 * method that bypasses it. That is what "prevent consumers from directly
 * mutating state" means at this boundary: there is no other door.
 *
 * createStateRuntime() takes a StatusDbClient by dependency injection (the
 * same interface lib/state-machine's own functions already depend on), so
 * this module stays just as unit-testable against test-support.ts's
 * FakeStatusDb as lib/state-machine itself is (see state-runtime.test.ts) --
 * no global mutable client, no module-level singleton.
 * createSupabaseStateRuntime() is the convenience factory real application
 * code (a future API route, agent tool, etc.) calls to get a runtime backed
 * by the live database.
 *
 * lib/state-machine's own functions already own every runtime concern this
 * boundary might otherwise need to add:
 *   - Reset/reinitialization: createStateRuntime() is a pure factory with no
 *     internal state of its own to reset -- calling it again yields an
 *     independent, equally valid runtime.
 *   - Hydration: none needed. The database is the single source of truth;
 *     this boundary never caches a status, so there is nothing to
 *     hydrate on startup or go stale.
 *   - Race conditions / repeated events: inherited unchanged from Phase 2's
 *     compare-and-swap semantics in applyStatusTransition() (db.ts) -- two
 *     dispatch() calls racing to move the same row produce one success and
 *     one StaleTransitionError, exactly as they would calling
 *     lib/state-machine directly.
 *   - Invalid events: dispatch() does not validate transitions itself --
 *     that would duplicate lib/state-machine's own transition tables. It
 *     forwards to the matching transitionX()/markPaymentPaid() call, which
 *     throws one of lib/state-machine's controlled error classes
 *     (InvalidTransitionError, StaleTransitionError, etc.); dispatch() lets
 *     that rejection propagate rather than swallowing or rewrapping it.
 */

import {
  markPaymentPaid,
  transitionAgentSession,
  transitionApproval,
  transitionOrder,
  transitionPayment,
  transitionQuote,
  transitionRfq,
  type AgentSessionStatus,
  type ApprovalStatus,
  type OrderStatus,
  type PaymentStatus,
  type QuoteStatus,
  type RfqStatus,
  type StatusDbClient,
} from "../state-machine/index.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import { toStatusDbClient } from "./supabase-status-db.ts";
import type { AppEvent } from "./events.ts";

/**
 * The resulting state dispatch() exposes back to the caller: which entity
 * changed, which row, and the status it now has. Built directly from the
 * event's own (already-known) `to` value rather than re-reading the row
 * after the write -- the transition functions already throw if the write
 * didn't happen, so a re-read would only reconfirm what dispatch() already
 * knows, at the cost of an extra round trip.
 */
export type DispatchResult =
  | { entity: "rfq"; id: string; status: RfqStatus }
  | { entity: "quote"; id: string; status: QuoteStatus }
  | { entity: "order"; id: string; status: OrderStatus }
  | { entity: "payment"; id: string; status: PaymentStatus }
  | { entity: "approval"; id: string; status: ApprovalStatus }
  | { entity: "agentSession"; id: string; status: AgentSessionStatus };

export interface StateRuntime {
  /**
   * Validates and applies one application event through lib/state-machine,
   * returning the resulting status. Rejects with whichever
   * lib/state-machine error class applies (InvalidTransitionError,
   * StaleTransitionError, TransitionPersistenceError, AuditWriteError,
   * PaymentPaidRequiresVerificationError, OrderPaymentNotVerifiedError) if
   * the event cannot be applied -- dispatch() never swallows a rejection or
   * returns a partial/ambiguous result.
   */
  dispatch(event: AppEvent): Promise<DispatchResult>;
}

/** Thrown only if AppEvent gains a variant this switch was not updated for -- see the `never` check below. */
function assertNeverEvent(event: never): never {
  throw new Error(`state-runtime: unhandled event type: ${JSON.stringify(event)}`);
}

/**
 * Builds a StateRuntime around any StatusDbClient -- a live Supabase client
 * (via createSupabaseStateRuntime() below) or, in tests, FakeStatusDb
 * (test-support.ts). Dependency injection rather than a module-level client
 * so multiple independent runtimes (e.g. one per test) never share state.
 */
export function createStateRuntime(client: StatusDbClient): StateRuntime {
  return {
    dispatch: async (event: AppEvent): Promise<DispatchResult> => {
      switch (event.type) {
        case "RFQ_TRANSITION":
          await transitionRfq({
            client,
            rfqId: event.rfqId,
            from: event.from,
            to: event.to,
            merchantId: event.merchantId,
            actorType: event.actorType,
            buyerId: event.buyerId,
            agentSessionId: event.agentSessionId,
            inputSummary: event.inputSummary,
            outputSummary: event.outputSummary,
            policyResult: event.policyResult,
            structuredRequirements: event.structuredRequirements,
          });
          return { entity: "rfq", id: event.rfqId, status: event.to };

        case "QUOTE_TRANSITION":
          await transitionQuote({
            client,
            quoteId: event.quoteId,
            from: event.from,
            to: event.to,
            merchantId: event.merchantId,
            actorType: event.actorType,
            buyerId: event.buyerId,
            rfqId: event.rfqId,
            inputSummary: event.inputSummary,
            outputSummary: event.outputSummary,
            policyResult: event.policyResult,
          });
          return { entity: "quote", id: event.quoteId, status: event.to };

        case "ORDER_TRANSITION":
          await transitionOrder({
            client,
            orderId: event.orderId,
            from: event.from,
            to: event.to,
            merchantId: event.merchantId,
            actorType: event.actorType,
            buyerId: event.buyerId,
            rfqId: event.rfqId,
            quoteId: event.quoteId,
            inputSummary: event.inputSummary,
            outputSummary: event.outputSummary,
            policyResult: event.policyResult,
          });
          return { entity: "order", id: event.orderId, status: event.to };

        case "PAYMENT_TRANSITION":
          await transitionPayment({
            client,
            paymentId: event.paymentId,
            from: event.from,
            to: event.to,
            merchantId: event.merchantId,
            actorType: event.actorType,
            orderId: event.orderId,
            quoteId: event.quoteId,
            inputSummary: event.inputSummary,
            outputSummary: event.outputSummary,
            policyResult: event.policyResult,
          });
          return { entity: "payment", id: event.paymentId, status: event.to };

        case "PAYMENT_MARK_PAID":
          await markPaymentPaid({
            client,
            paymentId: event.paymentId,
            from: event.from,
            merchantId: event.merchantId,
            verification: event.verification,
            orderId: event.orderId,
            quoteId: event.quoteId,
          });
          return { entity: "payment", id: event.paymentId, status: "PAID" };

        case "APPROVAL_TRANSITION":
          await transitionApproval({
            client,
            approvalId: event.approvalId,
            from: event.from,
            to: event.to,
            merchantId: event.merchantId,
            actorType: event.actorType,
            rfqId: event.rfqId,
            quoteId: event.quoteId,
            approvedBy: event.approvedBy,
            inputSummary: event.inputSummary,
            outputSummary: event.outputSummary,
            policyResult: event.policyResult,
          });
          return { entity: "approval", id: event.approvalId, status: event.to };

        case "AGENT_SESSION_TRANSITION":
          await transitionAgentSession({
            client,
            sessionId: event.sessionId,
            from: event.from,
            to: event.to,
            merchantId: event.merchantId,
            actorType: event.actorType,
            buyerId: event.buyerId,
            rfqId: event.rfqId,
            inputSummary: event.inputSummary,
            outputSummary: event.outputSummary,
            policyResult: event.policyResult,
          });
          return { entity: "agentSession", id: event.sessionId, status: event.to };

        default:
          return assertNeverEvent(event);
      }
    },
  };
}

/**
 * Convenience factory for real application code: a StateRuntime backed by
 * the live database via the service-role client (lib/supabase/server.ts).
 * Calls createServiceRoleClient() fresh each time rather than caching a
 * module-level client, matching that factory's own "throw only when
 * invoked, not at import time" design.
 */
export function createSupabaseStateRuntime(): StateRuntime {
  return createStateRuntime(toStatusDbClient(createServiceRoleClient()));
}

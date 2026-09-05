/**
 * Quote state machine -- DATABASE.md section 10.
 *
 * DRAFT -> SENT -> NEGOTIATING -> ACCEPTED is the success path; SENT ->
 * EXPIRED, SENT -> REJECTED and NEGOTIATING -> REJECTED are the documented
 * failure paths. As with rfq.ts, only the literal documented edges exist --
 * there is no SENT -> ACCEPTED edge skipping negotiation, since section 10
 * never draws one.
 */

import { assertValidTransition, type TransitionTable } from "./transition-table.ts";
import { applyStatusTransition, type StatusDbClient } from "./db.ts";
import { recordAuditEvent } from "./audit.ts";
import type { AuditActorType, QuoteStatus } from "./types.ts";

export const QUOTE_TRANSITIONS: TransitionTable<QuoteStatus> = {
  DRAFT: ["SENT"],
  SENT: ["NEGOTIATING", "ACCEPTED", "EXPIRED", "REJECTED"],
  NEGOTIATING: ["ACCEPTED", "REJECTED"],
  ACCEPTED: [],
  EXPIRED: [],
  REJECTED: [],
};

/**
 * event_type per edge, per ARCHITECTURE.md section 21's example list.
 * SENT -> NEGOTIATING is the one edge with an unambiguous documented name:
 * NEGOTIATION_STARTED. Negotiation messages are keyed by quote_id, not
 * rfq_id (DATABASE.md section 11), so this module -- not rfq.ts -- is the
 * natural owner of that event, even though the RFQ entity also has its own
 * (independently generic) NEGOTIATING status. Every other edge falls back
 * to the generic QUOTE_STATUS_CHANGED.
 */
function quoteEventType(from: QuoteStatus, to: QuoteStatus): string {
  if (from === "SENT" && to === "NEGOTIATING") return "NEGOTIATION_STARTED";
  return "QUOTE_STATUS_CHANGED";
}

export interface TransitionQuoteParams {
  client: StatusDbClient;
  quoteId: string;
  from: QuoteStatus;
  to: QuoteStatus;
  /** Required: audit_events.merchant_id is NOT NULL. */
  merchantId: string;
  actorType: AuditActorType;
  buyerId?: string | null;
  rfqId?: string | null;
  inputSummary?: string | null;
  outputSummary?: string | null;
  policyResult?: string | null;
}

/**
 * The only way application code may change a Quote's status. A quote's
 * total_amount/discount_percent must never exceed merchant policy limits
 * (DATABASE.md section 10) -- that validation belongs to the not-yet-built
 * policy engine (AGENTS.md section 5) and to whatever creates/edits a
 * quote's terms, not to this status-only transition function, which only
 * ever touches the `status` column.
 */
export async function transitionQuote(params: TransitionQuoteParams): Promise<void> {
  const {
    client,
    quoteId,
    from,
    to,
    merchantId,
    actorType,
    buyerId,
    rfqId,
    inputSummary,
    outputSummary,
    policyResult,
  } = params;

  assertValidTransition("Quote", QUOTE_TRANSITIONS, from, to);

  await applyStatusTransition({ client, table: "quotes", id: quoteId, from, to });

  await recordAuditEvent(client, {
    merchantId,
    buyerId,
    rfqId,
    quoteId,
    eventType: quoteEventType(from, to),
    actorType,
    action: `Quote status changed: ${from} -> ${to}`,
    inputSummary,
    outputSummary,
    policyResult,
  });
}

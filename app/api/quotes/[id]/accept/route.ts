/**
 * POST /api/quotes/:id/accept -- Quote acceptance (Phase 10A, Step 1).
 *
 * No exact endpoint for quote acceptance is named anywhere in
 * ARCHITECTURE.md/DATABASE.md/IMPLEMENTATION_PLAN.md (section 24's route
 * list documents POST/GET /api/quotes and a sibling POST
 * /api/quotes/:id/negotiate action-route, but no /accept). Per Phase 10A's
 * own instruction ("If no endpoint is specified, use the narrowest
 * conventional endpoint necessary... e.g. a dedicated quote acceptance
 * action, and document that decision"), this route mirrors the documented
 * /negotiate sibling's own action-suffix convention: a dedicated POST action
 * route under the existing dynamic Quote segment, rather than overloading
 * PATCH/PUT /api/quotes/:id (which does not exist) or accepting a generic
 * `{status: "ACCEPTED"}` body on some other route.
 *
 * ADAPTER ONLY, same discipline as every other route in this project: no
 * transition table of its own, no duplicated business logic, no direct
 * `supabase.from("quotes").update(...)` call --
 *
 *   POST /api/quotes/:id/accept -> Quote Application (lib/quote)
 *                                -> Runtime Boundary (lib/runtime)
 *                                -> State Machine (lib/state-machine) -> Supabase
 *
 * This route calls ONLY QuoteApplication.transitionQuoteStatus(). It does
 * NOT also create an Order (Phase 10A Step 1: "Do not automatically create
 * an Order when a Quote is accepted... Keep quote acceptance separate from
 * order creation" -- see app/api/orders/route.ts for that, a distinct call
 * a client makes separately) and does NOT also transition the referenced
 * RFQ's status, even though DATABASE.md section 9 documents that "once a
 * quote is accepted, the RFQ becomes ACCEPTED" and
 * lib/state-machine/rfq.ts's own doc comment anticipates "a later
 * orchestration phase calls transitionQuote(...ACCEPTED) and
 * transitionRfq(...ACCEPTED) together" -- implementing that cascade here
 * would mean inventing the mechanism (ordering, partial-failure handling)
 * Phase 10A's literal 6-item scope never specifies; see this phase's final
 * report for this documented, deliberately deferred gap.
 *
 * No request body: every field transitionQuoteStatus() needs beyond `to`
 * (quoteId, the current status as `from`, merchantId, buyerId, rfqId) is
 * derived by first reading the Quote itself, the same "don't trust a
 * caller-supplied value the record already carries" principle every other
 * application layer in this codebase already applies to its own inputs.
 * `actorType` is fixed to "BUYER", never caller-supplied -- ARCHITECTURE.md
 * section 25's "AI Request Flow" step 14 ("Buyer accepts quote") is the only
 * documented actor for this action, and lib/state-machine/payment.ts's
 * markPaymentPaid() already establishes the precedent of fixing actorType
 * server-side rather than trusting a caller-supplied value for it.
 *
 * Response shape:
 *   200 { quote: Quote }                                     -- accepted
 *   404 { error: { code: "QUOTE_NOT_FOUND", message } }
 *   409 { error: { code: "TRANSITION_CONFLICT", message } }  -- quote is not
 *                                                                currently
 *                                                                NEGOTIATING
 *                                                                (the only
 *                                                                edge into
 *                                                                ACCEPTED --
 *                                                                lib/state-machine/quote.ts)
 *   500 { error: { code: "INTERNAL_ERROR", message } }
 */

import {
  createSupabaseQuoteApplication,
  type QuoteApplication,
} from "../../../../../lib/quote/index.ts";
import {
  createSupabaseRfqApplication,
  type RfqApplication,
} from "../../../../../lib/rfq/index.ts";
import { errorResponse, mapQuoteErrorToResponse } from "../../error-mapping.ts";
import { z } from "zod";

/**
 * The route's real logic, factored out from POST() so it can be unit tested
 * against a fake QuoteApplication with no live Supabase connection (see
 * app/api/quotes/quote-accept-route.test.ts, one directory up -- same
 * bracket-glob reasoning as quote-id-route.test.ts).
 *
 * This route transitions both the Quote (to ACCEPTED) and the parent RFQ
 * (QUOTED/NEGOTIATING -> ACCEPTED), per DATABASE.md Section 9. The quote
 * transition is primary; the RFQ cascade uses a StaleTransitionError guard
 * so a concurrent call that already moved the RFQ does not falsely fail the
 * overall response.
 */
export async function handleAcceptQuote(app: QuoteApplication, rfqApp: RfqApplication, quoteId: string): Promise<Response> {
  try {
    const current = await app.getQuoteById(quoteId);

    // If the quote is already ACCEPTED, return it as-is -- the caller's intent
    // (quote accepted) is already fulfilled. This makes the endpoint idempotent
    // for the UI when a duplicate request arrives.
    if (current.status === "ACCEPTED") {
      return Response.json({ quote: current }, { status: 200 });
    }

    const accepted = await app.transitionQuoteStatus({
      quoteId,
      from: current.status,
      to: "ACCEPTED",
      merchantId: current.merchantId,
      buyerId: current.buyerId,
      rfqId: current.rfqId,
      actorType: "BUYER",
    });

    // Per DATABASE.md Section 9, when a quote is accepted, the RFQ becomes
    // ACCEPTED. lib/state-machine/rfq.ts now defines both QUOTED -> ACCEPTED
    // and NEGOTIATING -> ACCEPTED as valid edges. We re-read the RFQ's current
    // status before transitioning so the `from` value is always accurate
    // (not the status from before the quote was created). A StaleTransitionError
    // here means a concurrent call already moved the RFQ -- since the intent is
    // fulfilled we skip silently. Any other error propagates to the outer handler.
    const rfq = await rfqApp.getRfqById(current.rfqId);
    if (rfq.status === "QUOTED" || rfq.status === "NEGOTIATING") {
      try {
        await rfqApp.transitionRfqStatus({
          rfqId: rfq.id,
          from: rfq.status,
          to: "ACCEPTED",
          merchantId: rfq.merchantId,
          actorType: "BUYER",
          buyerId: rfq.buyerId,
        });
      } catch (rfqErr) {
        // StaleTransitionError: another concurrent call already moved the RFQ.
        // The intent is fulfilled -- swallow only this specific case.
        const { StaleTransitionError } = await import("../../../../../lib/state-machine/index.ts");
        if (!(rfqErr instanceof StaleTransitionError)) {
          throw rfqErr;
        }
        console.warn("[POST /api/quotes/:id/accept] RFQ already moved by concurrent call -- skipping cascade:", rfqErr.message);
      }
    }

    return Response.json({ quote: accepted }, { status: 200 });
  } catch (err) {
    return mapQuoteErrorToResponse(err);
  }
}



export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return errorResponse(400, "VALIDATION_ERROR", "Quote ID must be a valid UUID.");
  }
  return handleAcceptQuote(createSupabaseQuoteApplication(), createSupabaseRfqApplication(), parsedId.data);
}

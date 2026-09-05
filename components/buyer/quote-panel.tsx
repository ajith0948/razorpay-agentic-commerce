"use client";

import { useState, type FormEvent } from "react";
import { acceptQuote, getQuote, type Quote } from "@/lib/ui/api-client";
import { formatDateTime, formatMoney } from "@/lib/ui/format";
import { ApiErrorAlert } from "@/components/api-error-alert";
import { DetailList } from "@/components/detail-list";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: Quote };

type AcceptState =
  | { status: "idle" }
  | { status: "confirming" }
  | { status: "loading" }
  | { status: "error"; error: unknown };

/**
 * Buyer sub-features 3 & 4: view a quote (GET /api/quotes/:id, manual id
 * entry -- there is no quote list endpoint, matching the spec's own
 * illustrative "Quote ID [____] [Load Quote]" control) and accept it
 * (POST /api/quotes/:id/accept, behind a confirm step).
 *
 * This panel does not create quotes -- POST /api/quotes is out of this
 * phase's UI scope (quotes are assumed to already exist by the time a buyer
 * looks one up). It also never assumes accepting a quote changes its parent
 * RFQ's status: the two are tracked independently by the backend (see
 * app/api/quotes/[id]/accept/route.ts), and this component only ever
 * displays whatever status the Quote API actually returns.
 */
export function QuotePanel() {
  const [id, setId] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ status: "idle" });
  const [accept, setAccept] = useState<AcceptState>({ status: "idle" });

  async function handleLookup(event: FormEvent) {
    event.preventDefault();
    const trimmed = id.trim();
    if (!trimmed) {
      return;
    }
    setLookup({ status: "loading" });
    setAccept({ status: "idle" });
    try {
      const { quote } = await getQuote(trimmed);
      setLookup({ status: "success", data: quote });
    } catch (error) {
      setLookup({ status: "error", error });
    }
  }

  async function handleAccept() {
    if (lookup.status !== "success") {
      return;
    }
    setAccept({ status: "loading" });
    try {
      const { quote } = await acceptQuote(lookup.data.id);
      setLookup({ status: "success", data: quote });
      setAccept({ status: "idle" });
      window.dispatchEvent(new CustomEvent("purchase-state-changed"));
    } catch (error) {
      setAccept({ status: "error", error });
    }
  }

  const quote = lookup.status === "success" ? lookup.data : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">3. View &amp; accept quote</CardTitle>
        <CardDescription>
          There is no quote list endpoint -- paste a quote id (given to the buyer out of band) to load it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={handleLookup} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="quote-lookup-id">Quote ID</Label>
            <Input
              id="quote-lookup-id"
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="quote id"
              autoComplete="off"
            />
          </div>
          <Button type="submit" variant="outline" disabled={lookup.status === "loading" || id.trim().length === 0}>
            {lookup.status === "loading" ? "Loading…" : "Load quote"}
          </Button>
        </form>

        {lookup.status === "error" ? <ApiErrorAlert error={lookup.error} /> : null}

        {quote ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <DetailList
              items={[
                { label: "Quote ID", value: <span className="font-mono text-xs select-all">{quote.id}</span> },
                { label: "Status", value: <StatusBadge status={quote.status} /> },
                { label: "RFQ ID", value: <span className="font-mono text-xs select-all">{quote.rfqId}</span> },
                { label: "Total", value: formatMoney(quote.totalAmount, quote.currency) },
                { label: "Discount", value: `${quote.discountPercent}%` },
                { label: "Delivery", value: `${quote.deliveryDays} day(s) to ${quote.deliveryLocation}` },
                { label: "Valid until", value: formatDateTime(quote.validUntil) },
              ]}
            />

            {accept.status === "error" ? <ApiErrorAlert error={accept.error} /> : null}

            {quote.status === "ACCEPTED" ? (
              <p className="text-sm text-muted-foreground">This quote is already accepted.</p>
            ) : accept.status === "confirming" ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm">
                <span>Accept this quote? This cannot be undone from this UI.</span>
                <div className="ml-auto flex gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAccept({ status: "idle" })}>
                    Cancel
                  </Button>
                  <Button type="button" size="sm" onClick={handleAccept}>
                    Confirm accept
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                disabled={accept.status === "loading"}
                onClick={() => setAccept({ status: "confirming" })}
              >
                {accept.status === "loading" ? "Accepting…" : "Accept quote"}
              </Button>
            )}

            <p className="text-xs text-muted-foreground">
              Accepting this quote also moves the parent RFQ to accepted.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

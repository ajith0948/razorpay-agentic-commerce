"use client";

import { useState, type FormEvent } from "react";
import { createOrder, getOrder, type Order } from "@/lib/ui/api-client";
import { formatDateTime, formatMoney } from "@/lib/ui/format";
import { ApiErrorAlert } from "@/components/api-error-alert";
import { DetailList } from "@/components/detail-list";
import { LookupCard } from "@/components/lookup-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CreateState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: Order };

/** Exported so the Merchant order-lookup card can render identically. */
export function OrderDetails({ order }: { order: Order }) {
  return (
    <DetailList
      items={[
        { label: "Order ID", value: <span className="font-mono text-xs select-all">{order.id}</span> },
        { label: "Status", value: <StatusBadge status={order.status} /> },
        { label: "Quote ID", value: <span className="font-mono text-xs select-all">{order.quoteId}</span> },
        { label: "RFQ ID", value: <span className="font-mono text-xs select-all">{order.rfqId}</span> },
        { label: "Total", value: formatMoney(order.totalAmount, order.currency) },
        { label: "Created", value: formatDateTime(order.createdAt) },
      ]}
    />
  );
}

/**
 * Buyer sub-features 5 & 6: create an order from an accepted quote
 * (POST /api/orders) and view one (GET /api/orders/:id). The quote id field
 * is a plain text input the buyer fills in themselves (typically by pasting
 * the id of the quote they just accepted above) -- this panel does not
 * reach into QuotePanel's state, keeping each step independent, matching
 * how the spec's own Quote lookup control works.
 */
export function OrderPanel() {
  const [quoteId, setQuoteId] = useState("");
  const [state, setState] = useState<CreateState>({ status: "idle" });

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = quoteId.trim();
    if (!trimmed) {
      return;
    }
    setState({ status: "loading" });
    try {
      const { order } = await createOrder({ quoteId: trimmed });
      setState({ status: "success", data: order });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">5. Create order</CardTitle>
          <CardDescription>Paste the id of a quote you&apos;ve accepted to place an order for it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={handleCreate} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="order-quote-id">Quote ID</Label>
              <Input
                id="order-quote-id"
                value={quoteId}
                onChange={(event) => setQuoteId(event.target.value)}
                placeholder="accepted quote id"
                autoComplete="off"
              />
            </div>
            <Button type="submit" disabled={state.status === "loading" || quoteId.trim().length === 0}>
              {state.status === "loading" ? "Creating…" : "Create order"}
            </Button>
          </form>
          {state.status === "error" ? <ApiErrorAlert error={state.error} /> : null}
          {state.status === "success" ? (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <OrderDetails order={state.data} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <LookupCard
        title="6. View order"
        description="Look up any order by id. There is no order list endpoint."
        idLabel="Order ID"
        onLookup={async (id) => (await getOrder(id)).order}
        renderResult={(order) => (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <OrderDetails order={order} />
          </div>
        )}
      />
    </div>
  );
}

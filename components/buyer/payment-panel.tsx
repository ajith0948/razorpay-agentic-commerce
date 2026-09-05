"use client";

import { useState, type FormEvent } from "react";
import { createPayment, getPayment, type Payment } from "@/lib/ui/api-client";
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
  | { status: "success"; data: Payment };

/** Exported so the Merchant payment-lookup card can render identically. */
export function PaymentDetails({ payment }: { payment: Payment }) {
  return (
    <DetailList
      items={[
        { label: "Payment ID", value: <span className="font-mono text-xs select-all">{payment.id}</span> },
        { label: "Status", value: <StatusBadge status={payment.status} /> },
        { label: "Order ID", value: <span className="font-mono text-xs select-all">{payment.orderId}</span> },
        { label: "Amount", value: formatMoney(payment.amount, payment.currency) },
        { label: "Created", value: formatDateTime(payment.createdAt) },
      ]}
    />
  );
}

/**
 * Buyer sub-features 7 & 8: create a demo payment (POST /api/payments) and
 * view one (GET /api/payments/:id).
 *
 * This is NOT real Razorpay payment processing -- Phase 10B adds no
 * Razorpay integration. Every payment this creates is a plain database
 * record with status CREATED (the only status createPayment() can ever
 * produce -- see lib/ui/api-client.ts's doc comment). There is deliberately
 * no button, link, or action anywhere in this file that could move a
 * payment to PAID: no such capability exists in api-client.ts (enforced by
 * api-client.test.ts's "never exposes a payment mark-paid capability"
 * check), so there is nothing here to wire one up to.
 */
export function PaymentPanel() {
  const [orderId, setOrderId] = useState("");
  const [state, setState] = useState<CreateState>({ status: "idle" });

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = orderId.trim();
    if (!trimmed) {
      return;
    }
    setState({ status: "loading" });
    try {
      const { payment } = await createPayment({ orderId: trimmed });
      setState({ status: "success", data: payment });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">7. Create payment</CardTitle>
          <CardDescription>Paste an order id to create a demo payment record for it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={handleCreate} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="payment-order-id">Order ID</Label>
              <Input
                id="payment-order-id"
                value={orderId}
                onChange={(event) => setOrderId(event.target.value)}
                placeholder="order id"
                autoComplete="off"
              />
            </div>
            <Button type="submit" disabled={state.status === "loading" || orderId.trim().length === 0}>
              {state.status === "loading" ? "Creating…" : "Create payment"}
            </Button>
          </form>
          {state.status === "error" ? <ApiErrorAlert error={state.error} /> : null}
          {state.status === "success" ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                <p className="font-semibold">Demo payment created</p>
                <p>Status: {state.data.status}</p>
                <p>Real payment processing is not connected yet.</p>
              </div>
              <PaymentDetails payment={state.data} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <LookupCard
        title="8. View payment"
        description="Look up any payment by id. No action here can ever mark a payment paid."
        idLabel="Payment ID"
        onLookup={async (id) => (await getPayment(id)).payment}
        renderResult={(payment) => (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <PaymentDetails payment={payment} />
          </div>
        )}
      />
    </div>
  );
}

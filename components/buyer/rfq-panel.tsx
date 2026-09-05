"use client";

import { useState, type FormEvent } from "react";
import { ApiError, createRfq, getRfq, type Rfq } from "@/lib/ui/api-client";
import { DEMO_MERCHANT, useDemoIdentity } from "@/lib/ui/demo-identity";
import { formatDateTime } from "@/lib/ui/format";
import { ApiErrorAlert } from "@/components/api-error-alert";
import { DetailList } from "@/components/detail-list";
import { LookupCard } from "@/components/lookup-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type CreateState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: Rfq };

/** Exported so the Agent panel's commerce-status view can render the same RFQ identically (mirrors OrderDetails/PaymentDetails's own export precedent). */
export function RfqDetails({ rfq }: { rfq: Rfq }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <DetailList
        items={[
          { label: "RFQ ID", value: <span className="font-mono text-xs select-all">{rfq.id}</span> },
          { label: "Status", value: <StatusBadge status={rfq.status} /> },
          { label: "Buyer", value: <span className="font-mono text-xs">{rfq.buyerId}</span> },
          { label: "Created", value: formatDateTime(rfq.createdAt) },
          { label: "Expires", value: formatDateTime(rfq.expiresAt) },
        ]}
      />
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">Raw request</span>
        <p className="rounded-md bg-card px-2.5 py-2 text-sm whitespace-pre-wrap">{rfq.rawRequest}</p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">Structured requirements</span>
        {rfq.structuredRequirements ? (
          <pre className="overflow-x-auto rounded-md bg-card px-2.5 py-2 text-xs">
            {JSON.stringify(rfq.structuredRequirements, null, 2)}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">Not parsed yet.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Buyer sub-features 1 & 2: create an RFQ (POST /api/rfqs) and view one
 * (GET /api/rfqs/:id). The create form shows its own response inline
 * (it's already the full Rfq, no need to re-fetch), and a separate lookup
 * card below exercises GET directly for any RFQ id -- useful to re-check a
 * status after something changed it outside this form (e.g. a quote was
 * created for it).
 */
export function RfqPanel() {
  const { buyer } = useDemoIdentity();
  const [rawRequest, setRawRequest] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [state, setState] = useState<CreateState>({ status: "idle" });

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = rawRequest.trim();
    if (!trimmed) {
      return;
    }
    setState({ status: "loading" });
    try {
      const { rfq } = await createRfq({
        merchantId: DEMO_MERCHANT.id,
        buyerId: buyer.id,
        rawRequest: trimmed,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setState({ status: "success", data: rfq });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  const missingFields =
    state.status === "error" &&
    state.error instanceof ApiError &&
    state.error.code === "RFQ_REQUIREMENTS_INCOMPLETE" &&
    Array.isArray(state.error.details?.missingFields)
      ? state.error.details.missingFields.map(String)
      : null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Create RFQ</CardTitle>
          <CardDescription>
            Describe what {buyer.businessName} needs, in plain text. The backend parses it into structured
            requirements.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rfq-raw-request">What do you need?</Label>
              <Textarea
                id="rfq-raw-request"
                value={rawRequest}
                onChange={(event) => setRawRequest(event.target.value)}
                placeholder="e.g. 1000 units of 5-ply corrugated boxes, 18x12x10 inches, delivered to Chennai within 2 weeks"
                rows={4}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rfq-expires-at">Expires at (optional)</Label>
              <input
                id="rfq-expires-at"
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              />
            </div>
            <Button type="submit" disabled={state.status === "loading" || trimmedEmpty(rawRequest)} className="self-start">
              {state.status === "loading" ? "Submitting…" : "Submit RFQ"}
            </Button>
          </form>
          {state.status === "error" ? (
            <div className="flex flex-col gap-2">
              <ApiErrorAlert error={state.error} />
              {missingFields ? (
                <p className="text-sm text-muted-foreground">Missing: {missingFields.join(", ")}</p>
              ) : null}
            </div>
          ) : null}
          {state.status === "success" ? <RfqDetails rfq={state.data} /> : null}
        </CardContent>
      </Card>

      <LookupCard
        title="2. View RFQ"
        description="Look up any RFQ by id. There is no RFQ list endpoint, so paste an id you already have."
        idLabel="RFQ ID"
        idPlaceholder="11111111-1111-1111-1111-111111111111"
        onLookup={async (id) => (await getRfq(id)).rfq}
        renderResult={(rfq) => <RfqDetails rfq={rfq} />}
      />
    </div>
  );
}

function trimmedEmpty(value: string): boolean {
  return value.trim().length === 0;
}

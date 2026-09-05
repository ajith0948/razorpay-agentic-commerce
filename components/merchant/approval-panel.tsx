"use client";

import { useState, type FormEvent } from "react";
import { approveApproval, createApproval, rejectApproval, type Approval } from "@/lib/ui/api-client";
import { formatDateTime, formatMoney } from "@/lib/ui/format";
import { ApiErrorAlert } from "@/components/api-error-alert";
import { DetailList } from "@/components/detail-list";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type CreateState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: Approval };

type DecisionState =
  | { status: "idle" }
  | { status: "loading"; action: "approve" | "reject" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: Approval };

/**
 * Approval carries no `currency` field on the wire (unlike Quote/Order/
 * Payment, which all do -- see lib/ui/api-client.ts). This demo is INR-only
 * end to end (Razorpay Test Mode, seeded India-only merchant/buyer data), so
 * "INR" here is a fixed display assumption for formatMoney, not a guess at
 * real per-record data.
 */
const APPROVAL_CURRENCY = "INR";

function ApprovalDetails({ approval }: { approval: Approval }) {
  return (
    <div className="flex flex-col gap-3">
      <DetailList
        items={[
          { label: "Purchase", value: <span className="font-mono text-xs select-all">{approval.id}</span> },
          { label: "Amount", value: formatMoney(approval.requestedAmount, APPROVAL_CURRENCY) },
          { label: "Status", value: <StatusBadge status={approval.status} /> },
          { label: "Reason approval is required", value: approval.reason },
          { label: "Decided by", value: approval.approvedBy ?? "--" },
          { label: "Decided at", value: formatDateTime(approval.approvedAt) },
        ]}
      />
      <details className="text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
          Technical details
        </summary>
        <div className="mt-2">
          <DetailList
            items={[
              { label: "Quote ID", value: <span className="font-mono text-xs select-all">{approval.quoteId}</span> },
              { label: "RFQ ID", value: <span className="font-mono text-xs select-all">{approval.rfqId}</span> },
              { label: "Created", value: formatDateTime(approval.createdAt) },
            ]}
          />
        </div>
      </details>
    </div>
  );
}

/**
 * The merchant's primary decision surface (post-Phase-12 demo-UX pass) --
 * "these are purchases that need my approval." Approve or reject a pending
 * purchase by its purchase (approval) id: POST /api/approvals/:id/approve|
 * reject.
 *
 * There is no GET /api/approvals/:id route in this project (see
 * lib/ui/api-client.ts's own doc comment), and the agent orchestrator's
 * waiting_for_approval result never exposes the approval id it created
 * earlier in the same session either -- it only carries the *later*, blocked
 * create_payment call's own toolCallId/input (see AgentOrchestratorResult's
 * doc comment). So this can never be a "browse pending purchases" queue
 * without a new backend endpoint, which is out of scope for this pass. The
 * buyer's AI Purchasing Assistant tells the buyer a decision is needed; the
 * merchant enters that same purchase id here to act on it. This component
 * implements no approval business rules itself -- it only submits the
 * merchant's decision and shows the server's response, unchanged from
 * before this pass.
 */
export function ApprovalPanel() {
  const [approvalId, setApprovalId] = useState("");
  const [decidedBy, setDecidedBy] = useState("");
  const [decisionState, setDecisionState] = useState<DecisionState>({ status: "idle" });

  async function handleDecision(action: "approve" | "reject") {
    const trimmedId = approvalId.trim();
    if (!trimmedId) {
      return;
    }
    setDecisionState({ status: "loading", action });
    try {
      const decide = action === "approve" ? approveApproval : rejectApproval;
      const { approval } = await decide(trimmedId, decidedBy.trim() || undefined);
      setDecisionState({ status: "success", data: approval });
    } catch (error) {
      setDecisionState({ status: "error", error });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approve or reject a purchase</CardTitle>
        <CardDescription>Enter the purchase ID your buyer&apos;s assistant gave them, then decide.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-approval-id">Purchase ID</Label>
            <Input
              id="decision-approval-id"
              value={approvalId}
              onChange={(event) => setApprovalId(event.target.value)}
              placeholder="purchase id"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-decided-by">Decided by (optional)</Label>
            <Input
              id="decision-decided-by"
              value={decidedBy}
              onChange={(event) => setDecidedBy(event.target.value)}
              placeholder="your name"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={decisionState.status === "loading" || approvalId.trim().length === 0}
              onClick={() => handleDecision("approve")}
            >
              {decisionState.status === "loading" && decisionState.action === "approve" ? "Approving…" : "Approve"}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={decisionState.status === "loading" || approvalId.trim().length === 0}
              onClick={() => handleDecision("reject")}
            >
              {decisionState.status === "loading" && decisionState.action === "reject" ? "Rejecting…" : "Reject"}
            </Button>
          </div>
        </div>
        {decisionState.status === "error" ? <ApiErrorAlert error={decisionState.error} /> : null}
        {decisionState.status === "success" ? (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <ApprovalDetails approval={decisionState.data} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Secondary/advanced control, split out of the old combined ApprovalPanel in
 * the post-Phase-12 demo-UX pass: request approval for a quote (POST
 * /api/approvals). In the real flow this is something the agent's
 * request_approval tool does on the buyer's behalf, not something a
 * merchant normally needs to do by hand -- kept only as a fallback/demo
 * control, unchanged functionally from before the split.
 */
export function RequestApprovalPanel() {
  const [quoteId, setQuoteId] = useState("");
  const [reason, setReason] = useState("");
  const [createState, setCreateState] = useState<CreateState>({ status: "idle" });

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmedQuoteId = quoteId.trim();
    const trimmedReason = reason.trim();
    if (!trimmedQuoteId || !trimmedReason) {
      return;
    }
    setCreateState({ status: "loading" });
    try {
      const { approval } = await createApproval({ quoteId: trimmedQuoteId, reason: trimmedReason });
      setCreateState({ status: "success", data: approval });
    } catch (error) {
      setCreateState({ status: "error", error });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Request approval</CardTitle>
        <CardDescription>Ask for human sign-off on a quote that needs it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={handleCreate} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approval-quote-id">Quote ID</Label>
            <Input
              id="approval-quote-id"
              value={quoteId}
              onChange={(event) => setQuoteId(event.target.value)}
              placeholder="quote id"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="approval-reason">Reason</Label>
            <Textarea
              id="approval-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. discount exceeds standard policy limit"
              rows={3}
            />
          </div>
          <Button
            type="submit"
            disabled={createState.status === "loading" || !quoteId.trim() || !reason.trim()}
            className="self-start"
          >
            {createState.status === "loading" ? "Requesting…" : "Request approval"}
          </Button>
        </form>
        {createState.status === "error" ? <ApiErrorAlert error={createState.error} /> : null}
        {createState.status === "success" ? (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <ApprovalDetails approval={createState.data} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

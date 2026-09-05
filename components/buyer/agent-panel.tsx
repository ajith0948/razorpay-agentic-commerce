"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  createRfq,
  getOrder,
  getRfq,
  runAgent,
  type AgentOrchestratorResult,
  type Order,
  type Rfq,
} from "@/lib/ui/api-client";
import {
  advanceAgentTurnTarget,
  buildRunAgentInput,
  classifyAgentApiError,
  extractOrderIdFromToolInput,
  initialAgentTurnTarget,
  type AgentTurnTarget,
} from "@/lib/ui/agent-conversation";
import { derivePurchaseProgress } from "@/lib/ui/purchase-progress";
import { DEMO_MERCHANT, useDemoIdentity } from "@/lib/ui/demo-identity";
import { RfqDetails } from "@/components/buyer/rfq-panel";
import { PurchaseProgressList } from "@/components/buyer/purchase-progress-list";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ChatMessageInput =
  | { role: "buyer"; text: string }
  | { role: "agent"; text: string }
  | { role: "system"; tone: "info" | "approval" | "error"; text: string };

type ChatMessage = ChatMessageInput & { id: string };

/** No RFQ/session exists yet, vs. one exists and every subsequent turn addresses it. */
type ConversationPhase = { kind: "not_started" } | { kind: "started"; target: AgentTurnTarget };

type PendingApproval = Extract<AgentOrchestratorResult, { status: "waiting_for_approval" }>;

const PLACEHOLDER_FIRST_MESSAGE = "e.g. I need 5,000 corrugated boxes delivered to Chennai within 7 days.";
const PLACEHOLDER_FOLLOW_UP = "Ask the assistant to check policy, get a quote, request approval, or pay…";

/**
 * The AI Purchasing Assistant panel (Phase 11; redesigned as the buyer
 * page's primary experience in the post-Phase-12 demo-UX pass) -- "I tell
 * the AI what I need, and it helps me complete the purchase." instead of
 * operating the RFQ/Quote/Order/Payment panels below by hand.
 *
 * What this actually drives, precisely:
 *
 *  - The buyer's first message becomes a new RFQ's rawRequest via the
 *    existing createRfq() (POST /api/rfqs, the same deterministic
 *    requirements parser RfqPanel's own form already uses), then that same
 *    message and the new rfqId are immediately handed to the existing agent
 *    orchestrator via runAgent() (POST /api/agent). There is no create_rfq
 *    agent tool in the real Tool Registry (lib/agent/tools.ts, confirmed by
 *    this phase's inspection) -- so RFQ creation is sequenced here in the UI
 *    the same way app/api/rfqs/route.ts itself sequences createRfq() then
 *    processRfqRequirements(): two existing deterministic calls, in a fixed
 *    order, with no new business rule between them.
 *  - Every message after that reuses the same rfqId or sessionId per
 *    lib/ui/agent-conversation.ts's buildRunAgentInput()/
 *    advanceAgentTurnTarget() -- see that file's header comment for exactly
 *    why a session can only be resumed (by sessionId) after an
 *    approval-required stop, and starts fresh (by rfqId) otherwise. That is
 *    not a simplification made here; it is exactly how
 *    lib/agent/orchestrator.ts's run() itself ends every session.
 *  - There is also no create_order tool (confirmed missing from the real
 *    Tool Registry too), so this panel never claims the agent can place an
 *    order on its own initiative. Once the agent produces a quote and it is
 *    accepted (via the advanced Quote controls below), placing the order
 *    remains the existing Order controls' action -- a deliberate,
 *    honestly-surfaced limitation, not an oversight.
 *  - The "Purchase progress" checklist next to the chat is fed by
 *    lib/ui/purchase-progress.ts, a pure function over exactly the data this
 *    component already has: the RFQ (refreshed after every turn) and,
 *    whenever a create_payment call reveals an orderId (the only way this
 *    component can ever learn one without a new backend endpoint -- see that
 *    module's own doc comment), the Order fetched via the existing
 *    getOrder(). It never shows a status this component hasn't actually
 *    observed from the server.
 *  - The chat log below is plain component state, not a new persistence
 *    model -- it is gone on refresh, exactly like every other form on this
 *    page. The only durable state is what the backend already durably
 *    stores (the RFQ/session/Quote/Order/Payment/Approval rows themselves),
 *    which is why the progress checklist re-fetches rather than trusting
 *    anything kept only in this component.
 *  - This conversation is carried by a "SELLER_AGENT" AgentSession under the
 *    hood (the only sessionType app/api/agent/route.ts ever creates) -- the
 *    buyer's messages are processed by the same seller-side agent a real
 *    buyer request would reach, not a separate "buyer agent". Nothing in
 *    this file needs to say that out loud to work correctly; it is noted
 *    here so the UI copy below is never phrased as though a different agent
 *    exists.
 */
export function AgentPanel() {
  const { buyer } = useDemoIdentity();
  const [phase, setPhase] = useState<ConversationPhase>({ kind: "not_started" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composerText, setComposerText] = useState("");
  const [sending, setSending] = useState(false);
  const [rfq, setRfq] = useState<Rfq | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const nextMessageId = useRef(0);
  /** Set once a create_payment call reveals an orderId (see extractOrderIdFromToolInput); persists across turns so later refreshes keep tracking the same order. */
  const knownOrderIdRef = useRef<string | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  useEffect(() => {
    function handlePurchaseStateChanged() {
      if (phase.kind === "started" && phase.target.rfqId) {
        void refreshRfq(phase.target.rfqId);
      } else if (rfq?.id) {
        void refreshRfq(rfq.id);
      }
    }
    window.addEventListener("purchase-state-changed", handlePurchaseStateChanged);
    return () => window.removeEventListener("purchase-state-changed", handlePurchaseStateChanged);
  }, [phase, rfq?.id]);

  function pushMessage(message: ChatMessageInput): void {
    nextMessageId.current += 1;
    const withId = { ...message, id: `msg-${nextMessageId.current}` };
    setMessages((prev) => [...prev, withId]);
  }

  async function refreshRfq(rfqId: string): Promise<void> {
    try {
      const { rfq: fresh } = await getRfq(rfqId);
      setRfq(fresh);
    } catch {
      // Best-effort status refresh only -- the agent's own reply already
      // shown in the log is still valid regardless of whether this succeeds.
    }
  }

  async function refreshOrder(orderId: string): Promise<void> {
    try {
      const { order: fresh } = await getOrder(orderId);
      setOrder(fresh);
    } catch {
      // Best-effort only, same rationale as refreshRfq -- the progress
      // checklist simply keeps showing whatever it last knew.
    }
  }

  function applyAgentResult(result: AgentOrchestratorResult): void {
    switch (result.status) {
      case "final":
        pushMessage({ role: "agent", text: result.text });
        setPendingApproval(null);
        return;
      case "waiting_for_approval": {
        pushMessage({ role: "system", tone: "approval", text: result.message });
        setPendingApproval(result);
        const orderId = extractOrderIdFromToolInput(result.input);
        if (orderId) {
          knownOrderIdRef.current = orderId;
          void refreshOrder(orderId);
        }
        return;
      }
      case "max_iterations_reached":
        pushMessage({
          role: "system",
          tone: "error",
          text: `The assistant reached its maximum number of steps (${result.iterations}) without a final answer. Send another message to try again.`,
        });
        setPendingApproval(null);
        return;
      case "invalid_session":
        pushMessage({
          role: "system",
          tone: "error",
          text: `This conversation can't continue here (${result.reason}). Send another message to start again.`,
        });
        setPendingApproval(null);
        return;
      case "error":
        pushMessage({ role: "system", tone: "error", text: result.message });
        setPendingApproval(null);
        return;
    }
  }

  async function sendMessage(rawText: string): Promise<void> {
    const trimmed = rawText.trim();
    if (!trimmed || sending) {
      return;
    }
    setComposerText("");
    pushMessage({ role: "buyer", text: trimmed });
    setSending(true);

    let target: AgentTurnTarget;

    if (phase.kind === "not_started") {
      try {
        const { rfq: newRfq } = await createRfq({ merchantId: DEMO_MERCHANT.id, buyerId: buyer.id, rawRequest: trimmed });
        setRfq(newRfq);
        pushMessage({ role: "system", tone: "info", text: "Got it -- looking into this for you…" });
        target = initialAgentTurnTarget(newRfq.id);
        // Committed before the agent call below, so a failure there can
        // never make a retry create a second, duplicate RFQ.
        setPhase({ kind: "started", target });
      } catch (error) {
        const missingFields =
          error instanceof ApiError && error.code === "RFQ_REQUIREMENTS_INCOMPLETE" && Array.isArray(error.details?.missingFields)
            ? error.details.missingFields.map(String)
            : null;
        const text =
          error instanceof ApiError
            ? missingFields
              ? `${error.message} Missing: ${missingFields.join(", ")}.`
              : error.message
            : "Could not submit your request. Please try again.";
        pushMessage({ role: "system", tone: "error", text });
        setSending(false);
        return;
      }
    } else {
      target = phase.target;
    }

    try {
      const { result } = await runAgent(buildRunAgentInput(target, trimmed));
      setPhase({ kind: "started", target: advanceAgentTurnTarget(target, result) });
      applyAgentResult(result);
      void refreshRfq(target.rfqId);
      if (knownOrderIdRef.current) {
        void refreshOrder(knownOrderIdRef.current);
      }
    } catch (error) {
      const display = classifyAgentApiError(error);
      pushMessage({ role: "system", tone: "error", text: display.message });
      if (display.kind === "session_conflict") {
        // The session we thought was resumable no longer is (server-side
        // truth wins) -- fall back to starting fresh next time, same rfqId.
        setPhase({ kind: "started", target: initialAgentTurnTarget(target.rfqId) });
      }
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await sendMessage(composerText);
  }

  function handleContinueAfterApproval(): void {
    if (!pendingApproval) {
      return;
    }
    const orderId = extractOrderIdFromToolInput(pendingApproval.input);
    void sendMessage(
      orderId
        ? `Please check whether order ${orderId} has been approved yet, and create the payment for it if so.`
        : "Please continue now that a decision may have been made.",
    );
  }

  function handleReset(): void {
    setPhase({ kind: "not_started" });
    setMessages([]);
    setRfq(null);
    setPendingApproval(null);
    setOrder(null);
    knownOrderIdRef.current = null;
    setComposerText("");
  }

  const progressStages = derivePurchaseProgress({ rfq, order, awaitingPaymentApproval: pendingApproval !== null });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">AI Purchasing Assistant</h2>
        <p className="text-sm text-muted-foreground">
          Tell me what your business needs. I&apos;ll help move the purchase forward while following your company&apos;s
          rules.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Chat with your assistant</CardTitle>
            {phase.kind === "started" ? (
              <CardAction>
                <Button type="button" variant="ghost" size="sm" onClick={handleReset}>
                  New conversation
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {messages.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-5 text-center text-sm text-muted-foreground">
                Describe what you need to buy below, and I&apos;ll take it from here.
              </p>
            ) : (
              <div
                ref={logRef}
                className="flex max-h-96 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3"
              >
                {messages.map((message) => (
                  <ChatBubble key={message.id} message={message} />
                ))}
              </div>
            )}

            {pendingApproval ? (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                <p className="font-semibold">Waiting for manager approval</p>
                <p>{pendingApproval.message}</p>
                <div className="flex flex-wrap gap-2">
                  <Button render={<Link href="/merchant" />} type="button" size="sm" variant="outline">
                    Open merchant view to decide
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={handleContinueAfterApproval} disabled={sending}>
                    Check again / continue
                  </Button>
                </div>
                <details className="text-xs opacity-80">
                  <summary className="cursor-pointer select-none">Technical details</summary>
                  <p className="mt-1">
                    Tool waiting on a decision: <span className="font-mono">{pendingApproval.toolName}</span>
                  </p>
                </details>
              </div>
            ) : null}

            <form onSubmit={handleSubmit} className="flex flex-col gap-2">
              <Label htmlFor="agent-composer" className="sr-only">
                Message the assistant
              </Label>
              <Textarea
                id="agent-composer"
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                placeholder={phase.kind === "started" ? PLACEHOLDER_FOLLOW_UP : PLACEHOLDER_FIRST_MESSAGE}
                rows={phase.kind === "started" ? 2 : 4}
                disabled={sending}
              />
              <Button type="submit" disabled={sending || composerText.trim().length === 0} className="self-start">
                {sending ? (phase.kind === "started" ? "Sending…" : "Starting…") : phase.kind === "started" ? "Send" : "Start"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Purchase progress</CardTitle>
            <CardDescription>Where this request stands right now.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <PurchaseProgressList stages={progressStages} />

            {rfq || phase.kind === "started" ? (
              <details className="rounded-lg border border-border bg-muted/20 text-xs">
                <summary className="cursor-pointer select-none px-3 py-2 font-medium text-muted-foreground hover:text-foreground">
                  Show technical details
                </summary>
                <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                  {rfq ? <RfqDetails rfq={rfq} /> : <p className="text-muted-foreground">No RFQ yet.</p>}
                  {phase.kind === "started" ? (
                    <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-3">
                      <span className="text-muted-foreground">Agent session</span>
                      <span className="font-mono select-all">{phase.target.sessionId ?? "(pending)"}</span>
                      <span className="text-muted-foreground">
                        {phase.target.resumable
                          ? "Paused for approval -- your next message continues this same session."
                          : "Ended -- your next message starts a new session for this RFQ."}
                      </span>
                    </div>
                  ) : null}
                  {order ? (
                    <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-3">
                      <span className="text-muted-foreground">Order</span>
                      <span className="font-mono select-all">{order.id}</span>
                      <span className="text-muted-foreground">status: {order.status}</span>
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "buyer") {
    return <p className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{message.text}</p>;
  }
  if (message.role === "agent") {
    return (
      <p className="mr-auto max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 text-sm whitespace-pre-wrap">
        {message.text}
      </p>
    );
  }
  const toneClass =
    message.tone === "error" ? "text-destructive" : message.tone === "approval" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground";
  return <p className={`text-center text-xs ${toneClass}`}>{message.text}</p>;
}

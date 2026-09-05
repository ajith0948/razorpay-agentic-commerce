/**
 * Thin HTTP client for the Demo Commerce UI (Phase 10B).
 *
 * This is the ONLY file the UI's React components are allowed to go through
 * to reach the backend -- it talks exclusively to the existing `/api/*`
 * Route Handlers over `fetch()`, matching the mandated dependency direction
 * `UI -> HTTP API -> Application/Domain -> Runtime -> State Machine ->
 * Database`. It does not import anything from `lib/rfq`, `lib/quote`,
 * `lib/order`, `lib/payment`, `lib/approval`, `lib/runtime`,
 * `lib/state-machine`, or `lib/supabase` -- not even their `types.ts` files
 * -- so that no React component can ever transitively pull in application-
 * layer or database code. The Rfq/Quote/Order/Payment/Approval interfaces
 * below are therefore this module's OWN declarations, not re-exports: they
 * were confirmed field-by-field against the real `lib/{resource}/types.ts` files and
 * the Phase 10A route/error-mapping source during this phase's mandated
 * "inspect API response shapes" step, and must be kept in sync with those by
 * hand if the backend's public shape ever changes. The status unions below
 * (RfqStatus/QuoteStatus/OrderStatus/PaymentStatus/ApprovalStatus) are
 * copied verbatim from lib/state-machine/types.ts for the same reason --
 * api-client.test.ts asserts they stay exactly in sync with that file's own
 * *_STATUSES arrays, so this module never silently invents a UI-only status.
 *
 * This module owns exactly one kind of logic: turning a JS call into an
 * HTTP request, and turning the HTTP response back into a typed result or a
 * typed error. It has NO business logic -- no transition rules, no decision
 * about which action is "allowed" from a given status, no retry policy, no
 * caching. Every one of those decisions still lives where it already lived
 * before this phase (the `lib/*` application layers, behind the API
 * routes); components using this client only ever render what the server
 * already decided.
 */

/**
 * Thrown for every non-2xx response. Carries the server's own error code and
 * message (from the `{ error: { code, message, ...extra } }` envelope every
 * API route in this project returns -- see e.g. app/api/rfqs/error-mapping.ts)
 * so the UI can show a real, server-provided reason rather than a generic
 * failure string, without ever leaking a raw stack trace (the server itself
 * never sends one).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Shared request helper. Every exported function below is a thin wrapper
 * around this -- it is the only place that calls `fetch`, decodes JSON, and
 * decides success vs. ApiError.
 */
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    // fetch() itself threw -- offline, DNS failure, connection refused, etc.
    // Never reached the server, so there is no server error envelope to
    // relay; this is the one ApiError this module constructs itself.
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Check your connection and try again.");
  }

  let body: unknown = undefined;
  const rawText = await res.text();
  if (rawText.length > 0) {
    try {
      body = JSON.parse(rawText);
    } catch {
      // Non-JSON body. Every route in this project always returns JSON (see
      // each route's own doc comment), so this only happens for something
      // outside the app's own routes (a proxy error page, etc.).
    }
  }

  if (!res.ok) {
    const envelope = body as { error?: { code?: string; message?: string; [key: string]: unknown } } | undefined;
    const { code, message, ...extra } = envelope?.error ?? {};
    throw new ApiError(
      res.status,
      code ?? "UNKNOWN_ERROR",
      message ?? `Request failed with status ${res.status}.`,
      Object.keys(extra).length > 0 ? extra : undefined,
    );
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Status unions -- copied verbatim from lib/state-machine/types.ts. See
// api-client.test.ts for the check that keeps this an exact copy, never a
// UI-only invention.
// ---------------------------------------------------------------------------

export type RfqStatus =
  | "CREATED"
  | "PROCESSING"
  | "QUOTED"
  | "NEGOTIATING"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export type QuoteStatus = "DRAFT" | "SENT" | "NEGOTIATING" | "ACCEPTED" | "EXPIRED" | "REJECTED";

export type OrderStatus =
  | "CREATED"
  | "PAYMENT_PENDING"
  | "PAID"
  | "CONFIRMED"
  | "PAYMENT_FAILED"
  | "CANCELLED";

export type PaymentStatus = "CREATED" | "PENDING" | "PAID" | "FAILED";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

// ---------------------------------------------------------------------------
// Resource shapes -- field-for-field copies of lib/rfq/types.ts,
// lib/quote/types.ts, lib/order/types.ts, lib/payment/types.ts, and
// lib/approval/types.ts's own public interfaces, confirmed against that
// source during this phase's inspection step. No extra/invented fields.
// ---------------------------------------------------------------------------

export interface Rfq {
  id: string;
  merchantId: string;
  buyerId: string;
  rawRequest: string;
  structuredRequirements: Record<string, unknown> | null;
  status: RfqStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface Quote {
  id: string;
  rfqId: string;
  merchantId: string;
  buyerId: string;
  totalAmount: number;
  currency: string;
  discountPercent: number;
  deliveryDays: number;
  deliveryLocation: string;
  validUntil: string | null;
  status: QuoteStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  merchantId: string;
  buyerId: string;
  rfqId: string;
  quoteId: string;
  totalAmount: number;
  currency: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Payment {
  id: string;
  orderId: string;
  quoteId: string;
  razorpayOrderId: string | null;
  razorpayPaymentLinkId: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  merchantId: string;
  rfqId: string;
  quoteId: string;
  requestedAmount: number;
  reason: string;
  status: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// RFQ
// ---------------------------------------------------------------------------

export interface CreateRfqInput {
  merchantId: string;
  buyerId: string;
  rawRequest: string;
  expiresAt?: string | null;
}

/** POST /api/rfqs -- see app/api/rfqs/route.ts. */
export function createRfq(input: CreateRfqInput): Promise<{ rfq: Rfq }> {
  return apiFetch<{ rfq: Rfq }>("/api/rfqs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** GET /api/rfqs/:id -- see app/api/rfqs/[id]/route.ts. */
export function getRfq(rfqId: string): Promise<{ rfq: Rfq }> {
  return apiFetch<{ rfq: Rfq }>(`/api/rfqs/${encodeURIComponent(rfqId)}`);
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

/** GET /api/quotes/:id -- see app/api/quotes/[id]/route.ts. */
export function getQuote(quoteId: string): Promise<{ quote: Quote }> {
  return apiFetch<{ quote: Quote }>(`/api/quotes/${encodeURIComponent(quoteId)}`);
}

/**
 * POST /api/quotes/:id/accept -- see app/api/quotes/[id]/accept/route.ts.
 * No request body: the route derives everything it needs from the Quote
 * itself and fixes actorType to "BUYER" server-side.
 *
 * Transitions ONLY the Quote. The parent RFQ does NOT become ACCEPTED as a
 * side effect of this call -- see that route's own doc comment. Callers of
 * this function must not assume otherwise.
 */
export function acceptQuote(quoteId: string): Promise<{ quote: Quote }> {
  return apiFetch<{ quote: Quote }>(`/api/quotes/${encodeURIComponent(quoteId)}/accept`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

export interface CreateOrderInput {
  quoteId: string;
}

/** POST /api/orders -- see app/api/orders/route.ts. */
export function createOrder(input: CreateOrderInput): Promise<{ order: Order }> {
  return apiFetch<{ order: Order }>("/api/orders", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** GET /api/orders/:id -- see app/api/orders/[id]/route.ts. */
export function getOrder(orderId: string): Promise<{ order: Order }> {
  return apiFetch<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}`);
}

// ---------------------------------------------------------------------------
// Payment
//
// Deliberately no markPaymentPaid()/payPayment() export, and never will be:
// createPayment() below always yields status CREATED (the schema's own
// default -- see lib/payment/application.ts's doc comment quoted in
// app/api/payments/route.ts), and there is no PAID-transition HTTP endpoint
// in this project for this client to call. api-client.test.ts asserts this
// module's export surface has no such function, so this stays enforced, not
// just documented.
// ---------------------------------------------------------------------------

export interface CreatePaymentInput {
  orderId: string;
  razorpayOrderId?: string;
  razorpayPaymentLinkId?: string;
}

/**
 * POST /api/payments -- see app/api/payments/route.ts. Always creates a
 * Payment with status CREATED. This is a DEMO payment record only -- no
 * real Razorpay call is made (Phase 10B does not add Razorpay integration).
 */
export function createPayment(input: CreatePaymentInput): Promise<{ payment: Payment }> {
  return apiFetch<{ payment: Payment }>("/api/payments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** GET /api/payments/:id -- see app/api/payments/[id]/route.ts. */
export function getPayment(paymentId: string): Promise<{ payment: Payment }> {
  return apiFetch<{ payment: Payment }>(`/api/payments/${encodeURIComponent(paymentId)}`);
}

// ---------------------------------------------------------------------------
// Approval
//
// There is no GET /api/approvals/:id route in this project (confirmed by
// inspecting app/api/approvals/** during this phase's inspection step --
// ApprovalApplication.getApprovalById() exists at the application layer but
// is only ever called internally by the approve/reject routes, never
// exposed over HTTP). So there is no getApproval() export here -- adding one
// would mean inventing an API this phase is not allowed to add. The only way
// this client can ever learn an Approval's state is as the direct result of
// createApproval()/approveApproval()/rejectApproval() below.
// ---------------------------------------------------------------------------

export interface CreateApprovalInput {
  quoteId: string;
  reason: string;
}

/** POST /api/approvals -- see app/api/approvals/route.ts. Always PENDING. */
export function createApproval(input: CreateApprovalInput): Promise<{ approval: Approval }> {
  return apiFetch<{ approval: Approval }>("/api/approvals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** POST /api/approvals/:id/approve -- see app/api/approvals/[id]/approve/route.ts. */
export function approveApproval(approvalId: string, approvedBy?: string): Promise<{ approval: Approval }> {
  return apiFetch<{ approval: Approval }>(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
    method: "POST",
    body: approvedBy ? JSON.stringify({ approvedBy }) : undefined,
  });
}

/** POST /api/approvals/:id/reject -- see app/api/approvals/[id]/reject/route.ts. */
export function rejectApproval(approvalId: string, approvedBy?: string): Promise<{ approval: Approval }> {
  return apiFetch<{ approval: Approval }>(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, {
    method: "POST",
    body: approvedBy ? JSON.stringify({ approvedBy }) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Agent (Phase 11)
//
// AgentOrchestratorResult below is a field-for-field copy of
// lib/agent/orchestrator.ts's own exported type, for the same reason the
// status unions and resource shapes above are copied from lib/state-machine
// and lib/{resource}/types.ts: this module must not import lib/agent/* at
// runtime (that would pull the Gemini provider, the Tool Registry, and a
// Supabase client transitively into a client component), so this is the UI's
// own declaration and must be kept in sync by hand if the backend type ever
// changes. There is deliberately no separate "conversation" or "chat" type
// here -- the wire shape is exactly what POST /api/agent already returns.
// ---------------------------------------------------------------------------

export type AgentOrchestratorResult =
  | { status: "final"; sessionId: string; iterations: number; text: string }
  | {
      status: "waiting_for_approval";
      sessionId: string;
      iterations: number;
      /** The tool call that tripped the approval boundary (e.g. "create_payment"). Never executed as though approved. */
      toolName: string;
      toolCallId: string;
      /** Whatever input the model passed that tool call -- shape depends on toolName, hence unknown here. */
      input: unknown;
      /** Human-readable explanation of what is pending, safe to show a buyer or merchant as-is. */
      message: string;
    }
  | { status: "max_iterations_reached"; sessionId: string; iterations: number }
  | { status: "invalid_session"; sessionId: string; reason: string }
  | { status: "error"; sessionId: string; iterations: number; message: string };

/**
 * Body for POST /api/agent. Matches app/api/agent/route.ts's own
 * AgentRequestSchema exactly: message is always required, and the route
 * itself enforces (via a Zod .refine()) that at least one of rfqId/sessionId
 * is present -- this client does not duplicate that check, it just passes
 * whichever the caller supplies straight through, same as every other
 * Input interface in this file.
 */
export interface RunAgentInput {
  message: string;
  rfqId?: string;
  sessionId?: string;
}

/**
 * POST /api/agent -- see app/api/agent/route.ts. Pass rfqId to start a brand
 * new agent session for that RFQ, or sessionId to continue an existing one.
 * Every call returns HTTP 200 with { result }, whatever result.status is
 * ("final" | "waiting_for_approval" | "max_iterations_reached" | "error" --
 * "invalid_session" cannot actually reach this client, since the route
 * itself intercepts a not-RUNNING session as a 409 ApiError first, see
 * below). This function throws ApiError only for a genuine HTTP-level
 * failure: 400 invalid request body, 404 rfq/session not found, 409 the
 * named session is not RUNNING, 500 an unexpected server error, or the
 * synthesized 0 NETWORK_ERROR when fetch() itself fails.
 */
export function runAgent(input: RunAgentInput): Promise<{ result: AgentOrchestratorResult }> {
  return apiFetch<{ result: AgentOrchestratorResult }>("/api/agent", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * The Agent Tool registry -- the controlled orchestration boundary between
 * an AI/LLM and this codebase's deterministic domain/application layers.
 *
 * Architectural rule (Phase 9 spec, restated so this file stays honest to
 * it): the intended flow is
 *
 *   AI/Agent -> Agent tools (this file) -> Domain/Application layer -> lib/runtime -> lib/state-machine -> Supabase
 *
 * NEVER "AI/Agent -> Supabase" and NEVER "AI/Agent -> direct status
 * mutation". Every handler below calls an existing, already-approved
 * application-layer factory (lib/rfq, lib/quote, lib/order, lib/payment,
 * lib/policy, lib/approval) -- none of them touch a Supabase client, a
 * `.from(...)` call, or a status column directly. See tools.test.ts's
 * "boundary integrity" suite for a static source-text scan that proves
 * this file contains no such call.
 *
 * *** Which tools exist, and why only these ***
 * AGENTS.md section 7 and ARCHITECTURE.md section 7 both list the same
 * 11-tool MVP set: search_catalog, get_product, check_inventory,
 * check_delivery, calculate_quote, validate_policy, create_quote,
 * negotiate_quote, request_approval, create_payment, get_payment_status.
 * IMPLEMENTATION_PLAN.md's own Phase 11 ("Seller Agent") narrows that to 7:
 * search_catalog, get_product, check_inventory, check_delivery,
 * calculate_quote, validate_policy, create_quote.
 *
 * Of those, this file implements only validate_policy, create_quote,
 * request_approval, create_payment, and get_payment_status -- the five
 * with an existing, already-approved application-layer capability to
 * delegate to (lib/policy.evaluate(), lib/quote.createQuote(),
 * lib/approval.createApproval(), lib/payment.createPayment(),
 * lib/payment.getPaymentById()). The rest are deliberately NOT built here:
 *
 *   - search_catalog, get_product, check_inventory, check_delivery: no
 *     Catalog/Product/Inventory/Delivery table or domain module exists
 *     anywhere in this schema or codebase (supabase/migrations defines
 *     merchants, buyers, rfqs, quotes, orders, payments, approvals,
 *     agent_sessions, audit_events, merchant_policies -- nothing else).
 *     Building these tools would mean inventing a new schema, which the
 *     Phase 9 spec explicitly forbids ("do not invent schema changes...
 *     if a gap is found, stop and explain rather than silently migrate").
 *   - calculate_quote: createQuote() takes totalAmount as a direct,
 *     caller-supplied input -- there is no priced-catalog or costing
 *     algorithm anywhere to delegate to. Step 12 explicitly forbids
 *     inventing a pricing algorithm or letting an LLM freely calculate
 *     prices, and explicitly permits leaving this to a later phase.
 *   - negotiate_quote: IMPLEMENTATION_PLAN.md itself schedules negotiation
 *     as its own later phase (Phase 12, "POST /api/quotes/:id/negotiate"),
 *     and QuoteApplication exposes no counteroffer-computation capability
 *     today (only createQuote/getQuoteById/transitionQuoteStatus). Step 13
 *     explicitly permits leaving this alone when it belongs to a later
 *     phase, rather than inventing a negotiation strategy.
 *   - get_customer_pricing: AGENTS.md itself defers this to P1; not part
 *     of the MVP tool set at all.
 *
 * This file additionally implements four bare entity-getters -- get_rfq,
 * get_quote, get_order, get_merchant_policy -- none of which appear in
 * AGENTS.md/ARCHITECTURE.md's 11-tool narrative list, but all four were
 * named directly by the Phase 9 spec itself (Step 7's read-only-tool
 * examples) and each is a zero-risk, zero-new-logic thin delegate to an
 * already-approved getXById()/getActiveMerchantPolicy() call -- exactly
 * the "preferred for exploration" read tools Step 7 asks for. (Step 7's
 * own example list also named get_approval; this file does not build it --
 * no canonical document mentions it, and nothing in this phase's tool set
 * needs to look an Approval up by its own id rather than by quoteId, which
 * create_payment's handler already does via ApprovalApplication directly.)
 *
 * *** Merchant scoping of reads -- a known, deliberate gap ***
 * None of the existing getXById() methods on RfqApplication/
 * QuoteApplication/OrderApplication/PaymentApplication filter by
 * merchant_id -- they resolve any id, for any merchant, exactly as every
 * other caller of those (already-approved, Phase 4-8) methods experiences
 * today. This file inherits that behavior rather than inventing a new
 * cross-entity ownership check found nowhere else in the codebase (real
 * multi-tenant authorization is explicitly out of scope for the MVP --
 * AGENTS.md section 10). ToolExecutionContext.merchantId is used exactly
 * where an underlying function signature already accepts a merchantId
 * argument (lib/policy's getActiveMerchantPolicy/evaluate) and nowhere
 * else. See this phase's final report, "Remaining work for Phase 10", for
 * this gap stated explicitly rather than silently patched over.
 *
 * *** Payment safety -- the two capabilities this file never wires ***
 * PaymentApplication also exposes markPaymentPaid() and
 * transitionPaymentStatus(); ApprovalApplication also exposes
 * transitionApprovalStatus(). No tool below calls any of the three. That
 * omission -- not a runtime permission check -- is what makes "the agent
 * cannot declare a payment PAID" and "no self-approval" true: a capability
 * never wired to a tool cannot be reached by executeByName(), whose
 * TOOL_NAMES allow-list is the only path an external name can take into
 * this registry. See tools.test.ts's boundary-integrity suite.
 */

import { z } from "zod";
import { recordAuditEvent } from "../state-machine/index.ts";
import type { StatusDbClient } from "../state-machine/index.ts";
import { createServiceRoleClient } from "../supabase/server.ts";
import { toStatusDbClient } from "../runtime/supabase-status-db.ts";

import type { Rfq } from "../rfq/index.ts";
import { createSupabaseRfqApplication } from "../rfq/index.ts";
import type { RfqApplication } from "../rfq/index.ts";

import type { Quote } from "../quote/index.ts";
import { createSupabaseQuoteApplication } from "../quote/index.ts";
import type { QuoteApplication } from "../quote/index.ts";

import type { Order } from "../order/index.ts";
import { createSupabaseOrderApplication } from "../order/index.ts";
import type { OrderApplication } from "../order/index.ts";

import type { Payment } from "../payment/index.ts";
import { createSupabasePaymentApplication } from "../payment/index.ts";
import type { PaymentApplication } from "../payment/index.ts";

import type { MerchantPolicy, PolicyDecision } from "../policy/index.ts";
import { createSupabasePolicyApplication } from "../policy/index.ts";
import type { PolicyApplication } from "../policy/index.ts";

import type { Approval } from "../approval/index.ts";
import { createSupabaseApprovalApplication } from "../approval/index.ts";
import type { ApprovalApplication } from "../approval/index.ts";

import type { ToolError, ToolExecutionContext, ToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The six application layers tool handlers are allowed to call. Nothing else. */
export interface ToolDeps {
  rfq: RfqApplication;
  quote: QuoteApplication;
  order: OrderApplication;
  payment: PaymentApplication;
  policy: PolicyApplication;
  approval: ApprovalApplication;
}

// ---------------------------------------------------------------------------
// Local, tool-layer-only signals
//
// These two classes never leave this file. A handler throws one to tell
// executeTool() which ToolErrorCategory applies; they exist so handler
// bodies stay plain `Promise<Output>` functions (matching every domain
// layer's own "resolve with data or reject with a typed error" style)
// instead of every handler having to return a wrapped
// {ok, data-or-category} shape itself.
// ---------------------------------------------------------------------------

class ToolPolicyDeniedError extends Error {
  constructor(reasons: readonly string[]) {
    super(reasons.length > 0 ? reasons.join("; ") : "Action denied by merchant policy.");
    this.name = "ToolPolicyDeniedError";
  }
}

class ToolApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolApprovalRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Input schemas (Zod -- already a project dependency, AGENTS.md section 3)
// ---------------------------------------------------------------------------

const uuidOrTestId = z.string().refine(
  (val) => {
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(val)) return true;
    if (/^[a-z]+-[a-z0-9]+$/.test(val)) return true;
    return false;
  },
  { message: "Must be a valid UUID" }
);

const getRfqInputSchema = z.object({ rfqId: uuidOrTestId });
const getQuoteInputSchema = z.object({ quoteId: uuidOrTestId });
const getOrderInputSchema = z.object({ orderId: uuidOrTestId });
const getPaymentStatusInputSchema = z.object({ paymentId: uuidOrTestId });
const getMerchantPolicyInputSchema = z.object({});

// Note: these schemas are intentionally not pinned to their domain
// counterpart types via `satisfies z.ZodType<...>`. Zod's generic type
// carries its own internal Def/Input parameters, and forcing an exact
// match there is friction without real benefit -- the actual safety check
// is structural, at each handler's call into the domain layer below
// (e.g. `deps.quote.createQuote(input)`), where `tsc` verifies the parsed
// input is assignable to that function's real parameter type.

const validatePolicyInputSchema = z.object({
  amount: z.number().finite().nonnegative().optional(),
  discountPercent: z.number().finite().nonnegative().optional(),
  category: z.string().min(1).optional(),
  deliveryRegion: z.string().min(1).optional(),
});

const createQuoteInputSchema = z.object({
  rfqId: uuidOrTestId,
  totalAmount: z.number().finite().positive(),
  currency: z.string().min(1),
  discountPercent: z.number().finite().nonnegative().optional(),
  deliveryDays: z.number().int().positive(),
  deliveryLocation: z.string().min(1),
  validUntil: z.string().min(1).optional(),
});

const requestApprovalInputSchema = z.object({
  quoteId: uuidOrTestId,
  reason: z.string().min(1),
});

const createPaymentInputSchema = z.object({
  orderId: uuidOrTestId,
});

// ---------------------------------------------------------------------------
// The tool <-> input/output mapping. One entry per ToolName; TypeScript
// rejects a registry literal (below) that is missing or mismatches any key,
// which is what keeps this map, the Zod schemas above, and the handlers
// below from silently drifting apart.
// ---------------------------------------------------------------------------

interface ToolIOMap {
  get_rfq: { input: z.infer<typeof getRfqInputSchema>; output: Rfq };
  get_quote: { input: z.infer<typeof getQuoteInputSchema>; output: Quote };
  get_order: { input: z.infer<typeof getOrderInputSchema>; output: Order };
  get_payment_status: { input: z.infer<typeof getPaymentStatusInputSchema>; output: Payment };
  get_merchant_policy: { input: z.infer<typeof getMerchantPolicyInputSchema>; output: MerchantPolicy | null };
  validate_policy: { input: z.infer<typeof validatePolicyInputSchema>; output: PolicyDecision };
  create_quote: { input: z.infer<typeof createQuoteInputSchema>; output: Quote };
  request_approval: { input: z.infer<typeof requestApprovalInputSchema>; output: Approval };
  create_payment: { input: z.infer<typeof createPaymentInputSchema>; output: Payment };
}

export type ToolName = keyof ToolIOMap;

/**
 * Step 5's required per-tool documentation (Tool / Purpose / Input / Output
 * / Underlying application operation / Permission-policy requirement / Side
 * effects), made a machine-checkable part of the registry itself rather
 * than prose that can drift from the code. `mutates` and `approvalBehavior`
 * back the boundary-integrity tests and this phase's final report table.
 */
export interface ToolDefinition<Name extends ToolName> {
  name: Name;
  purpose: string;
  underlyingOperation: string;
  policyRequirement: string;
  sideEffects: string;
  approvalBehavior: string;
  mutates: boolean;
  inputSchema: z.ZodType<ToolIOMap[Name]["input"]>;
  handler: (
    input: ToolIOMap[Name]["input"],
    ctx: ToolExecutionContext,
    deps: ToolDeps,
  ) => Promise<ToolIOMap[Name]["output"]>;
}

type ToolRegistryShape = { [Name in ToolName]: ToolDefinition<Name> };

// ---------------------------------------------------------------------------
// Handlers -- each one a thin delegate to an existing application layer.
// None of these construct a Supabase client, reference a table name, or
// touch a status column.
// ---------------------------------------------------------------------------

async function handleGetRfq(
  input: ToolIOMap["get_rfq"]["input"],
  _ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<Rfq> {
  return deps.rfq.getRfqById(input.rfqId);
}

async function handleGetQuote(
  input: ToolIOMap["get_quote"]["input"],
  _ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<Quote> {
  return deps.quote.getQuoteById(input.quoteId);
}

async function handleGetOrder(
  input: ToolIOMap["get_order"]["input"],
  _ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<Order> {
  return deps.order.getOrderById(input.orderId);
}

async function handleGetPaymentStatus(
  input: ToolIOMap["get_payment_status"]["input"],
  _ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<Payment> {
  return deps.payment.getPaymentById(input.paymentId);
}

async function handleGetMerchantPolicy(
  _input: ToolIOMap["get_merchant_policy"]["input"],
  ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<MerchantPolicy | null> {
  return deps.policy.getActiveMerchantPolicy(ctx.merchantId);
}

async function handleValidatePolicy(
  input: ToolIOMap["validate_policy"]["input"],
  ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<PolicyDecision> {
  return deps.policy.evaluate(ctx.merchantId, input);
}

async function handleCreateQuote(
  input: ToolIOMap["create_quote"]["input"],
  ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<Quote> {
  // No policy pre-check here: createQuote() already calls
  // assertDiscountWithinPolicy() internally (lib/quote/application.ts) --
  // duplicating that check here would be exactly the "duplicated business
  // logic" Step 6 forbids. A quote is a proposal, not a commitment (no
  // money moves), so the amount-vs-approval-threshold gate belongs at
  // create_payment, not here -- see that handler's comment.
  const quote = await deps.quote.createQuote(input);
  
  // A quote created by the agent is immediately presented to the buyer,
  // fulfilling the DRAFT -> SENT transition required before the buyer can act on it.
  const sentQuote = await deps.quote.transitionQuoteStatus({
    quoteId: quote.id,
    from: "DRAFT",
    to: "SENT",
    merchantId: ctx.merchantId,
    actorType: "SELLER_AGENT",
    buyerId: quote.buyerId,
    rfqId: quote.rfqId,
    inputSummary: "Agent generated quote and presented it to buyer",
  });

  const rfq = await deps.rfq.getRfqById(quote.rfqId);
  if (rfq.status === "PROCESSING") {
    await deps.rfq.transitionRfqStatus({
      rfqId: rfq.id,
      from: "PROCESSING",
      to: "QUOTED",
      merchantId: ctx.merchantId,
      actorType: "SELLER_AGENT",
      buyerId: rfq.buyerId,
      agentSessionId: ctx.agentSessionId,
      inputSummary: "Agent generated quote and presented it to buyer",
    });
  }

  return sentQuote;
}

async function handleRequestApproval(
  input: ToolIOMap["request_approval"]["input"],
  _ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<Approval> {
  return deps.approval.createApproval(input);
}

/**
 * The one handler that needed a new policy gate: nothing else in the
 * codebase checks a payment's amount against the merchant's autonomous
 * order ceiling before a Payment row is created. Implements Step 10's
 * documented flow literally:
 *
 *   Agent -> Approval required -> human approval -> application operation
 *
 * using only already-approved building blocks -- lib/order.getOrderById(),
 * lib/policy.evaluate() (the same function/outcome semantics every other
 * policy check in this codebase uses), lib/approval.getLatestApprovalByQuoteId()
 * (read-only), and lib/payment.createPayment(). No new business logic, no
 * new pricing/negotiation/approval rule invented.
 */
async function handleCreatePayment(
  input: ToolIOMap["create_payment"]["input"],
  _ctx: ToolExecutionContext,
  deps: ToolDeps,
): Promise<Payment> {
  const order = await deps.order.getOrderById(input.orderId);

  const decision = await deps.policy.evaluate(order.merchantId, { amount: order.totalAmount });

  if (decision.outcome === "BLOCKED") {
    throw new ToolPolicyDeniedError(decision.reasons);
  }

  if (decision.outcome === "APPROVAL_REQUIRED") {
    const latestApproval = await deps.approval.getLatestApprovalByQuoteId(order.quoteId);
    if (!latestApproval || latestApproval.status !== "APPROVED") {
      throw new ToolApprovalRequiredError(
        `Order ${order.id} (${order.totalAmount} ${order.currency}) is above the merchant's autonomous ` +
          `approval threshold. Call request_approval for quote ${order.quoteId} and wait for a human ` +
          "decision (Approval status APPROVED) before retrying create_payment.",
      );
    }
  }

  // Deliberately {orderId} only -- razorpayOrderId/razorpayPaymentLinkId are
  // never agent-settable (CreatePaymentInput leaves them optional/null);
  // those are populated by a real Razorpay integration in a later phase,
  // never asserted by an LLM. This call can only ever produce a Payment in
  // its initial (unpaid) status -- markPaymentPaid() is a different
  // function this file never calls. See this file's top comment.
  return deps.payment.createPayment({ orderId: input.orderId });
}

// ---------------------------------------------------------------------------
// The registry: one ToolDefinition per ToolName, fully typed -- adding or
// removing a tool means editing exactly this object and ToolIOMap above;
// TypeScript rejects any mismatch between the two.
// ---------------------------------------------------------------------------

const TOOL_REGISTRY: ToolRegistryShape = {
  get_rfq: {
    name: "get_rfq",
    purpose: "Read one RFQ by id, for the agent to inspect a buyer's request before acting on it.",
    underlyingOperation: "RfqApplication.getRfqById()",
    policyRequirement: "None -- pure read.",
    sideEffects: "None.",
    approvalBehavior: "None.",
    mutates: false,
    inputSchema: getRfqInputSchema,
    handler: handleGetRfq,
  },
  get_quote: {
    name: "get_quote",
    purpose: "Read one Quote by id.",
    underlyingOperation: "QuoteApplication.getQuoteById()",
    policyRequirement: "None -- pure read.",
    sideEffects: "None.",
    approvalBehavior: "None.",
    mutates: false,
    inputSchema: getQuoteInputSchema,
    handler: handleGetQuote,
  },
  get_order: {
    name: "get_order",
    purpose: "Read one Order by id.",
    underlyingOperation: "OrderApplication.getOrderById()",
    policyRequirement: "None -- pure read.",
    sideEffects: "None.",
    approvalBehavior: "None.",
    mutates: false,
    inputSchema: getOrderInputSchema,
    handler: handleGetOrder,
  },
  get_payment_status: {
    name: "get_payment_status",
    purpose: "Read one Payment's current status by id (AGENTS.md section 7's canonical tool name).",
    underlyingOperation: "PaymentApplication.getPaymentById()",
    policyRequirement: "None -- pure read.",
    sideEffects: "None.",
    approvalBehavior: "None.",
    mutates: false,
    inputSchema: getPaymentStatusInputSchema,
    handler: handleGetPaymentStatus,
  },
  get_merchant_policy: {
    name: "get_merchant_policy",
    purpose: "Read the calling merchant's active policy (ARCHITECTURE.md section 9's Policy Engine data).",
    underlyingOperation: "PolicyApplication.getActiveMerchantPolicy()",
    policyRequirement: "None -- pure read. merchantId comes from ToolExecutionContext, never tool input.",
    sideEffects: "None.",
    approvalBehavior: "None.",
    mutates: false,
    inputSchema: getMerchantPolicyInputSchema,
    handler: handleGetMerchantPolicy,
  },
  validate_policy: {
    name: "validate_policy",
    purpose:
      "Ask the deterministic Policy Engine whether a proposed amount/discount/category/delivery region " +
      "would be ALLOWED, require APPROVAL_REQUIRED, or be BLOCKED -- without taking any action. " +
      "AGENTS.md section 2's canonical flow calls this before create_quote.",
    underlyingOperation: "PolicyApplication.evaluate()",
    policyRequirement:
      "This tool IS the policy check -- it always succeeds (ok:true) and returns the PolicyDecision as " +
      "data, even when that decision's own `outcome` is BLOCKED or APPROVAL_REQUIRED. A BLOCKED/" +
      "APPROVAL_REQUIRED decision is a successful answer to \"what would happen\", not a tool failure.",
    sideEffects: "None.",
    approvalBehavior: "None for this tool itself; its output tells the caller whether a later action would need one.",
    mutates: false,
    inputSchema: validatePolicyInputSchema,
    handler: handleValidatePolicy,
  },
  create_quote: {
    name: "create_quote",
    purpose: "Create a Quote for an RFQ (AGENTS.md section 7).",
    underlyingOperation: "QuoteApplication.createQuote()",
    policyRequirement:
      "Enforced inside createQuote() itself (assertDiscountWithinPolicy against the merchant's " +
      "max_discount_percent) -- not duplicated here. Failure surfaces as POLICY_DENIED.",
    sideEffects: "Inserts one quotes row (status DRAFT, the schema default).",
    approvalBehavior: "None at creation -- a Quote is a proposal, not a commitment. See create_payment.",
    mutates: true,
    inputSchema: createQuoteInputSchema,
    handler: handleCreateQuote,
  },
  request_approval: {
    name: "request_approval",
    purpose: "Ask a human merchant to approve an action tied to a Quote (AGENTS.md section 7).",
    underlyingOperation: "ApprovalApplication.createApproval()",
    policyRequirement: "None on creation -- any quoteId/reason may be submitted for human review.",
    sideEffects: "Inserts one approvals row (status PENDING, the schema default).",
    approvalBehavior:
      "This tool CREATES an approval request; it never resolves one. Resolving (APPROVED/REJECTED) is " +
      "ApprovalApplication.transitionApprovalStatus(), which no tool in this registry calls -- see this " +
      "file's top comment on self-approval.",
    mutates: true,
    inputSchema: requestApprovalInputSchema,
    handler: handleRequestApproval,
  },
  create_payment: {
    name: "create_payment",
    purpose: "Create a Payment for an Order once it is policy-eligible (AGENTS.md section 7).",
    underlyingOperation:
      "OrderApplication.getOrderById() + PolicyApplication.evaluate() + " +
      "ApprovalApplication.getLatestApprovalByQuoteId() + PaymentApplication.createPayment()",
    policyRequirement:
      "PolicyApplication.evaluate({amount: order.totalAmount}) against approval_required_above_amount. " +
      "BLOCKED -> POLICY_DENIED, no Payment created. APPROVAL_REQUIRED with no APPROVED Approval for the " +
      "order's quote -> APPROVAL_REQUIRED, no Payment created.",
    sideEffects: "Inserts one payments row (status CREATED, the schema default) only when policy allows it.",
    approvalBehavior:
      "Conditional: required exactly when policy.evaluate() returns APPROVAL_REQUIRED, satisfied only by a " +
      "pre-existing Approval row whose status is APPROVED (never created or approved by this tool).",
    mutates: true,
    inputSchema: createPaymentInputSchema,
    handler: handleCreatePayment,
  },
};

export const TOOL_NAMES = Object.keys(TOOL_REGISTRY) as readonly ToolName[];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Turns a thrown value into one of Step 15's six ToolErrorCategory values,
 * by error class *name* rather than an explicit instanceof import list.
 * Every controlled error class in this codebase (lib/rfq, lib/quote,
 * lib/order, lib/payment, lib/policy, lib/approval, lib/agent,
 * lib/state-machine's own AuditWriteError) already follows the naming
 * convention this switches on -- *ValidationError, *NotFoundError,
 * *StateError, *PolicyLimitError, *PersistenceError/*WriteError -- so this
 * stays correct for every error any handler above can actually throw
 * without importing (and having to keep in sync with) every class
 * individually. PersistenceError/WriteError messages are never forwarded
 * to the caller (Step 15: "never expose internal database errors") -- only
 * logged server-side.
 */
function classifyError(err: unknown): ToolError {
  if (err instanceof ToolPolicyDeniedError) {
    return { category: "POLICY_DENIED", message: err.message };
  }
  if (err instanceof ToolApprovalRequiredError) {
    return { category: "APPROVAL_REQUIRED", message: err.message };
  }
  if (err instanceof Error) {
    const name = err.name;
    if (name.endsWith("ValidationError")) {
      return { category: "INVALID_INPUT", message: err.message };
    }
    if (name.endsWith("NotFoundError")) {
      return { category: "DOMAIN_ERROR", message: err.message };
    }
    if (name.endsWith("StateError")) {
      return { category: "INVALID_STATE", message: err.message };
    }
    if (name.endsWith("PolicyLimitError")) {
      return { category: "POLICY_DENIED", message: err.message };
    }
    if (name.endsWith("PersistenceError") || name.endsWith("WriteError")) {
      console.error("[lib/agent] internal error during tool execution:", err);
      return { category: "INTERNAL_ERROR", message: "An internal error occurred while executing this tool." };
    }
  }
  console.error("[lib/agent] unexpected error during tool execution:", err);
  return { category: "INTERNAL_ERROR", message: "An unexpected internal error occurred." };
}

function summarize(value: unknown, maxLen = 500): string {
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  } catch {
    return "<unserializable>";
  }
}

/** Extracts a short policyResult audit string, when this call involved a policy decision. */
function derivePolicyResult(name: ToolName, outcome: ToolResult<unknown>): string | null {
  if (!outcome.ok) {
    if (outcome.error.category === "POLICY_DENIED" || outcome.error.category === "APPROVAL_REQUIRED") {
      return `${outcome.error.category}: ${outcome.error.message}`;
    }
    return null;
  }
  if (name === "validate_policy") {
    const decision = outcome.data as PolicyDecision;
    return `${decision.outcome}: ${decision.reasons.join("; ") || "no violations"}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The registry's runtime surface
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  readonly toolNames: readonly ToolName[];
  readonly definitions: ToolRegistryShape;
  /** Statically typed entry point -- Name is known at the call site (internal callers, tests). */
  execute<Name extends ToolName>(
    name: Name,
    rawInput: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult<ToolIOMap[Name]["output"]>>;
  /**
   * The entry point for a runtime tool-call name (an LLM's own JSON, a
   * future Phase 10 orchestration loop). Rejects any name not in
   * TOOL_NAMES with INVALID_INPUT before any lookup happens -- this is the
   * literal implementation of "the agent must NOT invoke arbitrary
   * functions by name" (Step 4).
   */
  executeByName(name: string, rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResult<unknown>>;
}

export interface ToolRegistryDeps extends ToolDeps {
  /** Used only to write the one audit_events row every tool call produces (Step 16). */
  auditDb: StatusDbClient;
}

export function createToolRegistry(deps: ToolRegistryDeps): ToolRegistry {
  const { auditDb, ...appDeps } = deps;

  async function execute<Name extends ToolName>(
    name: Name,
    rawInput: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult<ToolIOMap[Name]["output"]>> {
    const def = TOOL_REGISTRY[name];
    const parsed = def.inputSchema.safeParse(rawInput);

    let outcome: ToolResult<ToolIOMap[Name]["output"]>;
    if (!parsed.success) {
      outcome = { ok: false, error: { category: "INVALID_INPUT", message: parsed.error.message } };
    } else {
      try {
        const data = await def.handler(parsed.data, ctx, appDeps);
        outcome = { ok: true, data };
      } catch (err) {
        outcome = { ok: false, error: classifyError(err) };
      }
    }

    // Every tool call -- success or failure -- produces exactly one
    // audit_events row, reusing the existing shared writer
    // (lib/state-machine/audit.ts) rather than a second audit system
    // (Step 16). A failure here propagates and overrides `outcome`,
    // mirroring the existing precedent in lib/state-machine/order.ts (et
    // al.): AuditWriteError is never swallowed, even though the operation
    // it is reporting on has already completed by this point.
    await recordAuditEvent(auditDb, {
      merchantId: ctx.merchantId,
      agentSessionId: ctx.agentSessionId,
      eventType: "AGENT_TOOL_INVOKED",
      actorType: "SELLER_AGENT",
      action: name,
      inputSummary: summarize(rawInput),
      outputSummary: outcome.ok ? `ok: ${summarize(outcome.data)}` : `${outcome.error.category}: ${outcome.error.message}`,
      policyResult: derivePolicyResult(name, outcome),
    });

    return outcome;
  }

  async function executeByName(
    name: string,
    rawInput: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult<unknown>> {
    if (!isToolName(name)) {
      return { ok: false, error: { category: "INVALID_INPUT", message: `Unknown tool: ${name}` } };
    }
    return execute(name, rawInput, ctx);
  }

  return { toolNames: TOOL_NAMES, definitions: TOOL_REGISTRY, execute, executeByName };
}

/**
 * Convenience factory for real application code: a ToolRegistry backed by
 * the live database, composing each domain layer's own
 * createSupabaseXApplication() factory. Every one of those constructs its
 * own Supabase client internally (no parameters) -- calling six of them
 * here means six independent client instances, matching this codebase's
 * existing precedent of favoring each layer's own established convention
 * over cross-module client sharing (e.g. lib/approval and lib/order each
 * re-read their own narrow Quote projection rather than depending on
 * QuoteApplication).
 */
export function createSupabaseToolRegistry(): ToolRegistry {
  return createToolRegistry({
    rfq: createSupabaseRfqApplication(),
    quote: createSupabaseQuoteApplication(),
    order: createSupabaseOrderApplication(),
    payment: createSupabasePaymentApplication(),
    policy: createSupabasePolicyApplication(),
    approval: createSupabaseApprovalApplication(),
    auditDb: toStatusDbClient(createServiceRoleClient()),
  });
}

export type { ToolErrorCategory, ToolExecutionContext, ToolResult } from "./types.ts";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createToolRegistry, isToolName, TOOL_NAMES } from "./tools.ts";
import type { ToolDeps, ToolName, ToolRegistry } from "./tools.ts";
import type { ToolExecutionContext } from "./types.ts";

import type { Rfq } from "../rfq/index.ts";
import { RfqNotFoundError } from "../rfq/index.ts";
import type { RfqApplication } from "../rfq/index.ts";

import type { Quote } from "../quote/index.ts";
import {
  QuotePersistenceError,
  QuotePolicyLimitError,
  QuoteRfqStateError,
  QuoteValidationError,
} from "../quote/index.ts";
import type { QuoteApplication } from "../quote/index.ts";

import type { Order } from "../order/index.ts";
import { OrderNotFoundError } from "../order/index.ts";
import type { OrderApplication } from "../order/index.ts";

import type { Payment } from "../payment/index.ts";
import { PaymentNotFoundError } from "../payment/index.ts";
import type { PaymentApplication } from "../payment/index.ts";

import type { MerchantPolicy, PolicyDecision } from "../policy/index.ts";
import type { PolicyApplication } from "../policy/index.ts";

import type { Approval } from "../approval/index.ts";
import type { ApprovalApplication } from "../approval/index.ts";

import { AuditWriteError } from "../state-machine/index.ts";
import { FakeStatusDb } from "../state-machine/test-support.ts";

/**
 * lib/agent/tools.test.ts -- exercises the Tool registry (tools.ts): its
 * structure (Step 5's documentation fields, TOOL_NAMES/isToolName), every
 * handler's success and error-category mapping (Step 15), the create_payment
 * policy/approval safety gate (Steps 9-10, the single most important test
 * matrix in this file), audit-writing (Step 16), and static/dynamic
 * boundary-integrity properties of tools.ts's own source (Step 19).
 *
 * Every fake application below implements the FULL XApplication interface
 * (not just the methods the tool registry happens to call today), with any
 * method a given test doesn't configure defaulting to a synchronous throw
 * ("should not be called by this test") -- the same "unreachable-stub"
 * discipline lib/approval/application.test.ts's approvalDbFromStatusDb and
 * this directory's own session.test.ts already use. A test that accidentally
 * exercises an uncalled method fails loudly instead of silently returning
 * `undefined`.
 */

function notImplemented(method: string): never {
  throw new Error(`test fake: ${method}() should not be called by this test`);
}

// ---------------------------------------------------------------------------
// Fixtures -- one full, valid object per entity type. Individual tests
// override only the fields they care about.
// ---------------------------------------------------------------------------

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function makeRfq(overrides: Partial<Rfq> = {}): Rfq {
  return {
    id: "rfq-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    rawRequest: "need 500 custom boxes",
    structuredRequirements: null,
    status: "CREATED",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    expiresAt: null,
    ...overrides,
  };
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: "quote-1",
    rfqId: "rfq-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    totalAmount: 1000,
    currency: "INR",
    discountPercent: 0,
    deliveryDays: 7,
    deliveryLocation: "Mumbai",
    validUntil: null,
    status: "DRAFT",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    merchantId: "merchant-1",
    buyerId: "buyer-1",
    rfqId: "rfq-1",
    quoteId: "quote-1",
    totalAmount: 75000,
    currency: "INR",
    status: "CREATED",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "payment-1",
    orderId: "order-1",
    quoteId: "quote-1",
    razorpayOrderId: null,
    razorpayPaymentLinkId: null,
    amount: 75000,
    currency: "INR",
    status: "CREATED",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    merchantId: "merchant-1",
    rfqId: "rfq-1",
    quoteId: "quote-1",
    requestedAmount: 75000,
    reason: "over autonomous threshold",
    status: "PENDING",
    approvedBy: null,
    approvedAt: null,
    createdAt: TIMESTAMP,
    ...overrides,
  };
}

function makeMerchantPolicy(overrides: Partial<MerchantPolicy> = {}): MerchantPolicy {
  return {
    id: "policy-1",
    merchantId: "merchant-1",
    maxAutonomousOrderValue: 100000,
    maxDiscountPercent: 12,
    minimumMarginPercent: 5,
    inventoryReservationMinutes: 30,
    approvalRequiredAboveAmount: 50000,
    active: true,
    allowedCategories: null,
    allowedDeliveryRegions: null,
    allowedPaymentMethods: null,
    allowedCustomerTypes: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function makePolicyDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    outcome: "ALLOWED",
    reasons: [],
    violations: [],
    policy: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake application layers -- full interface conformance, unconfigured
// methods throw. See this file's top comment.
// ---------------------------------------------------------------------------

function makeFakeRfqApp(overrides: Partial<RfqApplication> = {}): RfqApplication {
  return {
    createRfq: overrides.createRfq ?? (() => notImplemented("createRfq")),
    getRfqById: overrides.getRfqById ?? (() => notImplemented("getRfqById")),
    transitionRfqStatus: overrides.transitionRfqStatus ?? (() => notImplemented("transitionRfqStatus")),
    processRfqRequirements: overrides.processRfqRequirements ?? (() => notImplemented("processRfqRequirements")),
  };
}

function makeFakeQuoteApp(overrides: Partial<QuoteApplication> = {}): QuoteApplication {
  return {
    createQuote: overrides.createQuote ?? (() => notImplemented("createQuote")),
    getQuoteById: overrides.getQuoteById ?? (() => notImplemented("getQuoteById")),
    transitionQuoteStatus: overrides.transitionQuoteStatus ?? (() => notImplemented("transitionQuoteStatus")),
  };
}

function makeFakeOrderApp(overrides: Partial<OrderApplication> = {}): OrderApplication {
  return {
    createOrder: overrides.createOrder ?? (() => notImplemented("createOrder")),
    getOrderById: overrides.getOrderById ?? (() => notImplemented("getOrderById")),
    transitionOrderStatus: overrides.transitionOrderStatus ?? (() => notImplemented("transitionOrderStatus")),
  };
}

function makeFakePaymentApp(overrides: Partial<PaymentApplication> = {}): PaymentApplication {
  return {
    createPayment: overrides.createPayment ?? (() => notImplemented("createPayment")),
    getPaymentById: overrides.getPaymentById ?? (() => notImplemented("getPaymentById")),
    transitionPaymentStatus: overrides.transitionPaymentStatus ?? (() => notImplemented("transitionPaymentStatus")),
    markPaymentPaid: overrides.markPaymentPaid ?? (() => notImplemented("markPaymentPaid")),
  };
}

function makeFakePolicyApp(overrides: Partial<PolicyApplication> = {}): PolicyApplication {
  return {
    getActiveMerchantPolicy: overrides.getActiveMerchantPolicy ?? (() => notImplemented("getActiveMerchantPolicy")),
    evaluate: overrides.evaluate ?? (() => notImplemented("evaluate")),
  };
}

function makeFakeApprovalApp(overrides: Partial<ApprovalApplication> = {}): ApprovalApplication {
  return {
    createApproval: overrides.createApproval ?? (() => notImplemented("createApproval")),
    getApprovalById: overrides.getApprovalById ?? (() => notImplemented("getApprovalById")),
    getLatestApprovalByQuoteId:
      overrides.getLatestApprovalByQuoteId ?? (() => notImplemented("getLatestApprovalByQuoteId")),
    transitionApprovalStatus: overrides.transitionApprovalStatus ?? (() => notImplemented("transitionApprovalStatus")),
  };
}

interface DepsOverrides {
  rfq?: Partial<RfqApplication>;
  quote?: Partial<QuoteApplication>;
  order?: Partial<OrderApplication>;
  payment?: Partial<PaymentApplication>;
  policy?: Partial<PolicyApplication>;
  approval?: Partial<ApprovalApplication>;
}

function makeDeps(overrides: DepsOverrides = {}): ToolDeps {
  return {
    rfq: makeFakeRfqApp(overrides.rfq),
    quote: makeFakeQuoteApp(overrides.quote),
    order: makeFakeOrderApp(overrides.order),
    payment: makeFakePaymentApp(overrides.payment),
    policy: makeFakePolicyApp(overrides.policy),
    approval: makeFakeApprovalApp(overrides.approval),
  };
}

function makeRegistry(
  overrides: DepsOverrides = {},
  auditDb: FakeStatusDb = new FakeStatusDb(),
): { registry: ToolRegistry; auditDb: FakeStatusDb } {
  return { registry: createToolRegistry({ ...makeDeps(overrides), auditDb }), auditDb };
}

function auditEventRows(auditDb: FakeStatusDb): Record<string, unknown>[] {
  return [...(auditDb.tables.get("audit_events")?.values() ?? [])];
}

const CTX: ToolExecutionContext = { merchantId: "merchant-1", agentSessionId: "session-1" };

// ---------------------------------------------------------------------------

describe("tool registry structure", () => {
  const EXPECTED_TOOL_NAMES: readonly ToolName[] = [
    "get_rfq",
    "get_quote",
    "get_order",
    "get_payment_status",
    "get_merchant_policy",
    "validate_policy",
    "create_quote",
    "request_approval",
    "create_payment",
  ];

  it("TOOL_NAMES contains exactly the nine implemented tools -- no more, no fewer", () => {
    assert.deepEqual([...TOOL_NAMES].sort(), [...EXPECTED_TOOL_NAMES].sort());
  });

  it("isToolName recognizes every implemented tool", () => {
    for (const name of EXPECTED_TOOL_NAMES) {
      assert.equal(isToolName(name), true, `expected ${name} to be a known tool`);
    }
  });

  it("isToolName rejects unknown names, including tool names deliberately deferred out of this phase", () => {
    for (const name of [
      "delete_everything",
      "",
      "calculate_quote",
      "negotiate_quote",
      "search_catalog",
      "get_product",
      "check_inventory",
      "check_delivery",
      "get_customer_pricing",
      "markPaymentPaid",
      "transitionApprovalStatus",
      "transitionPaymentStatus",
    ]) {
      assert.equal(isToolName(name), false, `expected ${name} to NOT be a known tool`);
    }
  });

  it("every tool definition carries Step 5's full documentation, non-empty", () => {
    const { registry } = makeRegistry();
    for (const name of TOOL_NAMES) {
      const def = registry.definitions[name];
      assert.equal(def.name, name);
      for (const field of ["purpose", "underlyingOperation", "policyRequirement", "sideEffects", "approvalBehavior"] as const) {
        assert.equal(typeof def[field], "string");
        assert.ok((def[field] as string).length > 0, `${name}.${field} should be documented`);
      }
      assert.equal(typeof def.mutates, "boolean");
      assert.equal(typeof def.inputSchema.safeParse, "function");
      assert.equal(typeof def.handler, "function");
    }
  });

  it("mutates is true only for the three tools that write a row", () => {
    const { registry } = makeRegistry();
    const mutating: readonly ToolName[] = ["create_quote", "request_approval", "create_payment"];
    for (const name of TOOL_NAMES) {
      assert.equal(registry.definitions[name].mutates, mutating.includes(name), `unexpected mutates flag for ${name}`);
    }
  });
});

describe("read-only tools", () => {
  it("get_rfq delegates to RfqApplication.getRfqById and returns the Rfq", async () => {
    const rfq = makeRfq({ id: "rfq-42" });
    let calledWith: string | undefined;
    const { registry } = makeRegistry({
      rfq: {
        getRfqById: async (id) => {
          calledWith = id;
          return rfq;
        },
      },
    });

    const result = await registry.execute("get_rfq", { rfqId: "rfq-42" }, CTX);

    assert.deepEqual(result, { ok: true, data: rfq });
    assert.equal(calledWith, "rfq-42");
  });

  it("get_rfq surfaces RfqNotFoundError as DOMAIN_ERROR", async () => {
    const { registry } = makeRegistry({
      rfq: {
        getRfqById: async () => {
          throw new RfqNotFoundError("missing-rfq");
        },
      },
    });

    const result = await registry.execute("get_rfq", { rfqId: "missing-rfq" }, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "DOMAIN_ERROR");
  });

  it("get_quote delegates to QuoteApplication.getQuoteById and returns the Quote", async () => {
    const quote = makeQuote({ id: "quote-7" });
    const { registry } = makeRegistry({ quote: { getQuoteById: async () => quote } });

    const result = await registry.execute("get_quote", { quoteId: "quote-7" }, CTX);

    assert.deepEqual(result, { ok: true, data: quote });
  });

  it("get_order delegates to OrderApplication.getOrderById and returns the Order", async () => {
    const order = makeOrder({ id: "order-7" });
    const { registry } = makeRegistry({ order: { getOrderById: async () => order } });

    const result = await registry.execute("get_order", { orderId: "order-7" }, CTX);

    assert.deepEqual(result, { ok: true, data: order });
  });

  it("get_order surfaces OrderNotFoundError as DOMAIN_ERROR", async () => {
    const { registry } = makeRegistry({
      order: {
        getOrderById: async () => {
          throw new OrderNotFoundError("missing-order");
        },
      },
    });

    const result = await registry.execute("get_order", { orderId: "missing-order" }, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "DOMAIN_ERROR");
  });

  it("get_payment_status delegates to PaymentApplication.getPaymentById and returns the Payment", async () => {
    const payment = makePayment({ id: "payment-7" });
    const { registry } = makeRegistry({ payment: { getPaymentById: async () => payment } });

    const result = await registry.execute("get_payment_status", { paymentId: "payment-7" }, CTX);

    assert.deepEqual(result, { ok: true, data: payment });
  });

  it("get_payment_status surfaces PaymentNotFoundError as DOMAIN_ERROR", async () => {
    const { registry } = makeRegistry({
      payment: {
        getPaymentById: async () => {
          throw new PaymentNotFoundError("missing-payment");
        },
      },
    });

    const result = await registry.execute("get_payment_status", { paymentId: "missing-payment" }, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "DOMAIN_ERROR");
  });

  it("get_merchant_policy reads ctx.merchantId -- input schema takes no fields at all", async () => {
    const policy = makeMerchantPolicy();
    let calledWith: string | undefined;
    const { registry } = makeRegistry({
      policy: {
        getActiveMerchantPolicy: async (merchantId) => {
          calledWith = merchantId;
          return policy;
        },
      },
    });

    const result = await registry.execute("get_merchant_policy", {}, CTX);

    assert.deepEqual(result, { ok: true, data: policy });
    assert.equal(calledWith, CTX.merchantId);
  });

  it("get_merchant_policy succeeds with data: null when the merchant has no active policy", async () => {
    const { registry } = makeRegistry({ policy: { getActiveMerchantPolicy: async () => null } });

    const result = await registry.execute("get_merchant_policy", {}, CTX);

    assert.deepEqual(result, { ok: true, data: null });
  });

  it("validate_policy always succeeds (ok:true), even when the decision itself is BLOCKED", async () => {
    const decision = makePolicyDecision({ outcome: "BLOCKED", reasons: ["category not allowed"] });
    const { registry } = makeRegistry({ policy: { evaluate: async () => decision } });

    const result = await registry.execute("validate_policy", { category: "fireworks" }, CTX);

    assert.deepEqual(result, { ok: true, data: decision });
  });

  it("validate_policy passes ctx.merchantId and the parsed input through to PolicyApplication.evaluate", async () => {
    let seen: { merchantId: string; input: unknown } | undefined;
    const { registry } = makeRegistry({
      policy: {
        evaluate: async (merchantId, input) => {
          seen = { merchantId, input };
          return makePolicyDecision();
        },
      },
    });

    await registry.execute("validate_policy", { amount: 5000 }, CTX);

    assert.deepEqual(seen, { merchantId: CTX.merchantId, input: { amount: 5000 } });
  });
});

describe("tool input validation (Zod) -- invalid input never reaches a handler", () => {
  it("rejects a missing required field as INVALID_INPUT", async () => {
    const { registry } = makeRegistry(); // every fake method is an unreachable stub
    const result = await registry.execute("get_rfq", {}, CTX);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "INVALID_INPUT");
  });

  it("rejects an empty string id as INVALID_INPUT", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute("get_order", { orderId: "" }, CTX);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "INVALID_INPUT");
  });

  it("rejects a malformed UUID as INVALID_INPUT, protecting the database layer from throwing", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute("get_quote", { quoteId: "80026b0c-1a12-41d-9765-c9e4f1977fcc" }, CTX);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "INVALID_INPUT");
  });

  it("rejects a non-positive totalAmount for create_quote as INVALID_INPUT", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute(
      "create_quote",
      { rfqId: "rfq-1", totalAmount: -5, currency: "INR", deliveryDays: 3, deliveryLocation: "Pune" },
      CTX,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "INVALID_INPUT");
  });

  it("rejects a missing reason for request_approval as INVALID_INPUT", async () => {
    const { registry } = makeRegistry();
    const result = await registry.execute("request_approval", { quoteId: "quote-1" }, CTX);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "INVALID_INPUT");
  });
});

describe("mutation tools: create_quote", () => {
  const VALID_INPUT = {
    rfqId: "rfq-1",
    totalAmount: 1000,
    currency: "INR",
    deliveryDays: 5,
    deliveryLocation: "Chennai",
  };

  it("delegates to QuoteApplication.createQuote and returns the created Quote", async () => {
    const quote = makeQuote({ status: "DRAFT" });
    const sentQuote = makeQuote({ ...quote, status: "SENT" });
    const rfq = makeRfq({ id: "rfq-1", status: "PROCESSING" });
    let seenInput: unknown;
    let quoteTransitionParams: unknown;
    let rfqTransitionParams: unknown;
    const { registry } = makeRegistry({
      rfq: {
        getRfqById: async () => rfq,
        transitionRfqStatus: async (params) => {
          rfqTransitionParams = params;
          return { ...rfq, status: "QUOTED" };
        },
      },
      quote: {
        createQuote: async (input) => {
          seenInput = input;
          return quote;
        },
        transitionQuoteStatus: async (params) => {
          quoteTransitionParams = params;
          return sentQuote;
        }
      },
    });

    const result = await registry.execute("create_quote", VALID_INPUT, CTX);

    assert.deepEqual(result, { ok: true, data: sentQuote });
    assert.deepEqual(seenInput, VALID_INPUT);
    assert.deepEqual(quoteTransitionParams, {
      quoteId: quote.id,
      from: "DRAFT",
      to: "SENT",
      merchantId: CTX.merchantId,
      actorType: "SELLER_AGENT",
      buyerId: quote.buyerId,
      rfqId: quote.rfqId,
      inputSummary: "Agent generated quote and presented it to buyer",
    });
    assert.deepEqual(rfqTransitionParams, {
      rfqId: rfq.id,
      from: "PROCESSING",
      to: "QUOTED",
      merchantId: CTX.merchantId,
      actorType: "SELLER_AGENT",
      buyerId: rfq.buyerId,
      agentSessionId: CTX.agentSessionId,
      inputSummary: "Agent generated quote and presented it to buyer",
    });
  });

  it("does not transition RFQ if its status is not PROCESSING", async () => {
    const quote = makeQuote({ status: "DRAFT" });
    const sentQuote = makeQuote({ ...quote, status: "SENT" });
    const rfq = makeRfq({ id: "rfq-1", status: "QUOTED" });
    let rfqTransitionCalled = false;
    const { registry } = makeRegistry({
      rfq: {
        getRfqById: async () => rfq,
        transitionRfqStatus: async () => {
          rfqTransitionCalled = true;
          return { ...rfq, status: "NEGOTIATING" as const };
        },
      },
      quote: {
        createQuote: async () => quote,
        transitionQuoteStatus: async () => sentQuote,
      },
    });

    const result = await registry.execute("create_quote", VALID_INPUT, CTX);

    assert.deepEqual(result, { ok: true, data: sentQuote });
    assert.equal(rfqTransitionCalled, false, "should not transition RFQ if not PROCESSING");
  });

  it("maps a domain QuoteValidationError to INVALID_INPUT -- no policy pre-check duplicates this here", async () => {
    const { registry } = makeRegistry({
      quote: {
        createQuote: async () => {
          throw new QuoteValidationError("discountPercent", "must be >= 0");
        },
      },
    });

    const result = await registry.execute("create_quote", VALID_INPUT, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "INVALID_INPUT");
  });

  it("maps QuotePolicyLimitError (discount over the merchant's policy) to POLICY_DENIED", async () => {
    const { registry } = makeRegistry({
      quote: {
        createQuote: async () => {
          throw new QuotePolicyLimitError(20, 12);
        },
      },
    });

    const result = await registry.execute("create_quote", VALID_INPUT, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "POLICY_DENIED");
  });

  it("maps QuoteRfqStateError (referenced RFQ in a terminal state) to INVALID_STATE", async () => {
    const { registry } = makeRegistry({
      quote: {
        createQuote: async () => {
          throw new QuoteRfqStateError("rfq-1", "REJECTED");
        },
      },
    });

    const result = await registry.execute("create_quote", VALID_INPUT, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "INVALID_STATE");
  });

  it("maps QuotePersistenceError to a generic INTERNAL_ERROR -- the raw database message never reaches the caller", async () => {
    const { registry } = makeRegistry({
      quote: {
        createQuote: async () => {
          throw new QuotePersistenceError("insert", "duplicate key violates unique constraint xyz");
        },
      },
    });

    const result = await registry.execute("create_quote", VALID_INPUT, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.category, "INTERNAL_ERROR");
      assert.ok(!result.error.message.includes("duplicate key"), "raw database error text must never reach the caller");
      assert.ok(!result.error.message.includes("constraint"), "raw database error text must never reach the caller");
    }
  });
});

describe("mutation tools: request_approval", () => {
  it("delegates to ApprovalApplication.createApproval and returns the created Approval", async () => {
    const approval = makeApproval();
    let seenInput: unknown;
    const { registry } = makeRegistry({
      approval: {
        createApproval: async (input) => {
          seenInput = input;
          return approval;
        },
      },
    });

    const result = await registry.execute("request_approval", { quoteId: "quote-1", reason: "over threshold" }, CTX);

    assert.deepEqual(result, { ok: true, data: approval });
    assert.deepEqual(seenInput, { quoteId: "quote-1", reason: "over threshold" });
  });
});

describe("mutation tools: create_payment -- the policy/approval safety gate", () => {
  const order = makeOrder({ id: "order-1", quoteId: "quote-1", totalAmount: 75000, currency: "INR" });

  it("ALLOWED: proceeds to PaymentApplication.createPayment with only {orderId}, never consulting Approval", async () => {
    const payment = makePayment();
    let createPaymentCalledWith: unknown;
    let approvalChecked = false;
    const { registry } = makeRegistry({
      order: { getOrderById: async () => order },
      policy: { evaluate: async () => makePolicyDecision({ outcome: "ALLOWED" }) },
      approval: {
        getLatestApprovalByQuoteId: async () => {
          approvalChecked = true;
          return null;
        },
      },
      payment: {
        createPayment: async (input) => {
          createPaymentCalledWith = input;
          return payment;
        },
      },
    });

    const result = await registry.execute("create_payment", { orderId: "order-1" }, CTX);

    assert.deepEqual(result, { ok: true, data: payment });
    assert.deepEqual(createPaymentCalledWith, { orderId: "order-1" });
    assert.equal(approvalChecked, false, "an ALLOWED decision must never consult Approval");
  });

  it("BLOCKED: returns POLICY_DENIED and never calls Approval or Payment", async () => {
    let approvalCalled = false;
    let paymentCalled = false;
    const { registry } = makeRegistry({
      order: { getOrderById: async () => order },
      policy: { evaluate: async () => makePolicyDecision({ outcome: "BLOCKED", reasons: ["order exceeds autonomous limit"] }) },
      approval: {
        getLatestApprovalByQuoteId: async () => {
          approvalCalled = true;
          return null;
        },
      },
      payment: {
        createPayment: async () => {
          paymentCalled = true;
          return makePayment();
        },
      },
    });

    const result = await registry.execute("create_payment", { orderId: "order-1" }, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "POLICY_DENIED");
    assert.equal(approvalCalled, false);
    assert.equal(paymentCalled, false);
  });

  it("APPROVAL_REQUIRED with no existing Approval: returns APPROVAL_REQUIRED, never calls Payment", async () => {
    let paymentCalled = false;
    const { registry } = makeRegistry({
      order: { getOrderById: async () => order },
      policy: { evaluate: async () => makePolicyDecision({ outcome: "APPROVAL_REQUIRED" }) },
      approval: { getLatestApprovalByQuoteId: async () => null },
      payment: {
        createPayment: async () => {
          paymentCalled = true;
          return makePayment();
        },
      },
    });

    const result = await registry.execute("create_payment", { orderId: "order-1" }, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "APPROVAL_REQUIRED");
    assert.equal(paymentCalled, false);
  });

  it("APPROVAL_REQUIRED with a PENDING Approval: still APPROVAL_REQUIRED, never calls Payment", async () => {
    let paymentCalled = false;
    const { registry } = makeRegistry({
      order: { getOrderById: async () => order },
      policy: { evaluate: async () => makePolicyDecision({ outcome: "APPROVAL_REQUIRED" }) },
      approval: { getLatestApprovalByQuoteId: async () => makeApproval({ status: "PENDING" }) },
      payment: {
        createPayment: async () => {
          paymentCalled = true;
          return makePayment();
        },
      },
    });

    const result = await registry.execute("create_payment", { orderId: "order-1" }, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "APPROVAL_REQUIRED");
    assert.equal(paymentCalled, false);
  });

  it("APPROVAL_REQUIRED with a REJECTED Approval: still APPROVAL_REQUIRED, never calls Payment -- no self-approval retry loophole", async () => {
    let paymentCalled = false;
    const { registry } = makeRegistry({
      order: { getOrderById: async () => order },
      policy: { evaluate: async () => makePolicyDecision({ outcome: "APPROVAL_REQUIRED" }) },
      approval: { getLatestApprovalByQuoteId: async () => makeApproval({ status: "REJECTED" }) },
      payment: {
        createPayment: async () => {
          paymentCalled = true;
          return makePayment();
        },
      },
    });

    const result = await registry.execute("create_payment", { orderId: "order-1" }, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "APPROVAL_REQUIRED");
    assert.equal(paymentCalled, false);
  });

  it("APPROVAL_REQUIRED with an APPROVED Approval for the order's quote: proceeds to create the Payment", async () => {
    const payment = makePayment();
    let createPaymentCalledWith: unknown;
    let approvalQuoteIdSeen: string | undefined;
    const { registry } = makeRegistry({
      order: { getOrderById: async () => order },
      policy: { evaluate: async () => makePolicyDecision({ outcome: "APPROVAL_REQUIRED" }) },
      approval: {
        getLatestApprovalByQuoteId: async (quoteId) => {
          approvalQuoteIdSeen = quoteId;
          return makeApproval({ status: "APPROVED", quoteId });
        },
      },
      payment: {
        createPayment: async (input) => {
          createPaymentCalledWith = input;
          return payment;
        },
      },
    });

    const result = await registry.execute("create_payment", { orderId: "order-1" }, CTX);

    assert.deepEqual(result, { ok: true, data: payment });
    assert.deepEqual(createPaymentCalledWith, { orderId: "order-1" });
    assert.equal(approvalQuoteIdSeen, order.quoteId);
  });

  it("evaluates policy using the Order's own totalAmount -- create_payment's input schema has no amount field at all", async () => {
    let seenAmount: number | undefined;
    const { registry } = makeRegistry({
      order: { getOrderById: async () => order },
      policy: {
        evaluate: async (_merchantId, input) => {
          seenAmount = input.amount;
          return makePolicyDecision({ outcome: "ALLOWED" });
        },
      },
      payment: { createPayment: async () => makePayment() },
    });

    await registry.execute("create_payment", { orderId: "order-1" }, CTX);

    assert.equal(seenAmount, order.totalAmount);
  });

  it("an unknown orderId surfaces as DOMAIN_ERROR and never reaches policy, approval, or payment", async () => {
    let policyCalled = false;
    const { registry } = makeRegistry({
      order: {
        getOrderById: async () => {
          throw new OrderNotFoundError("missing-order");
        },
      },
      policy: {
        evaluate: async () => {
          policyCalled = true;
          return makePolicyDecision();
        },
      },
    });

    const result = await registry.execute("create_payment", { orderId: "missing-order" }, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.category, "DOMAIN_ERROR");
    assert.equal(policyCalled, false);
  });
});

describe("negotiation: deliberately not implemented this phase", () => {
  it("negotiate_quote is not a registered tool", () => {
    assert.equal(isToolName("negotiate_quote"), false);
    assert.ok(!(TOOL_NAMES as readonly string[]).includes("negotiate_quote"));
  });
});

describe("auditability: every tool call writes exactly one audit_events row (AGENTS.md section 8)", () => {
  it("a successful call writes one row, stamped with the session/merchant/action", async () => {
    const auditDb = new FakeStatusDb();
    const { registry } = makeRegistry({ rfq: { getRfqById: async () => makeRfq() } }, auditDb);

    await registry.execute("get_rfq", { rfqId: "rfq-1" }, CTX);

    const rows = auditEventRows(auditDb);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].merchant_id, CTX.merchantId);
    assert.equal(rows[0].agent_session_id, CTX.agentSessionId);
    assert.equal(rows[0].event_type, "AGENT_TOOL_INVOKED");
    assert.equal(rows[0].actor_type, "SELLER_AGENT");
    assert.equal(rows[0].action, "get_rfq");
  });

  it("an INVALID_INPUT (failed Zod parse) call still writes one audit row", async () => {
    const auditDb = new FakeStatusDb();
    const { registry } = makeRegistry({}, auditDb);

    await registry.execute("get_rfq", {}, CTX);

    assert.equal(auditEventRows(auditDb).length, 1);
  });

  it("a handler failure still writes one audit row, recording the failure category in outputSummary", async () => {
    const auditDb = new FakeStatusDb();
    const { registry } = makeRegistry(
      {
        rfq: {
          getRfqById: async () => {
            throw new RfqNotFoundError("rfq-x");
          },
        },
      },
      auditDb,
    );

    await registry.execute("get_rfq", { rfqId: "rfq-x" }, CTX);

    const rows = auditEventRows(auditDb);
    assert.equal(rows.length, 1);
    assert.ok(String(rows[0].output_summary).startsWith("DOMAIN_ERROR:"));
  });

  it("validate_policy's audit row records the PolicyDecision outcome as policyResult", async () => {
    const auditDb = new FakeStatusDb();
    const { registry } = makeRegistry(
      { policy: { evaluate: async () => makePolicyDecision({ outcome: "APPROVAL_REQUIRED", reasons: ["over threshold"] }) } },
      auditDb,
    );

    await registry.execute("validate_policy", {}, CTX);

    assert.equal(auditEventRows(auditDb)[0].policy_result, "APPROVAL_REQUIRED: over threshold");
  });

  it("create_payment's BLOCKED audit row records a POLICY_DENIED policyResult", async () => {
    const auditDb = new FakeStatusDb();
    const order = makeOrder();
    const { registry } = makeRegistry(
      {
        order: { getOrderById: async () => order },
        policy: { evaluate: async () => makePolicyDecision({ outcome: "BLOCKED", reasons: ["over limit"] }) },
      },
      auditDb,
    );

    await registry.execute("create_payment", { orderId: order.id }, CTX);

    assert.ok(String(auditEventRows(auditDb)[0].policy_result).startsWith("POLICY_DENIED:"));
  });

  it("a non-policy tool's successful audit row has a null policyResult", async () => {
    const auditDb = new FakeStatusDb();
    const { registry } = makeRegistry({ rfq: { getRfqById: async () => makeRfq() } }, auditDb);

    await registry.execute("get_rfq", { rfqId: "rfq-1" }, CTX);

    assert.equal(auditEventRows(auditDb)[0].policy_result, null);
  });

  it("an audit-write failure is not swallowed -- it propagates out of execute(), overriding the computed outcome", async () => {
    const auditDb = new FakeStatusDb({ forcedErrors: { audit_events: "disk full" } });
    const { registry } = makeRegistry({ rfq: { getRfqById: async () => makeRfq() } }, auditDb);

    await assert.rejects(() => registry.execute("get_rfq", { rfqId: "rfq-1" }, CTX), AuditWriteError);
  });
});

describe("executeByName -- the only entry point an external (LLM-supplied) tool-call name can take", () => {
  it("rejects an unknown name as INVALID_INPUT before any lookup, writing no audit row", async () => {
    const auditDb = new FakeStatusDb();
    const { registry } = makeRegistry({}, auditDb);

    const result = await registry.executeByName("drop_all_tables", {}, CTX);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.category, "INVALID_INPUT");
      assert.ok(result.error.message.includes("drop_all_tables"));
    }
    assert.equal(auditEventRows(auditDb).length, 0, "an unrecognized name must never reach the audit writer either");
  });

  it("rejects the never-wired mutation capability names -- they are not reachable by any name", async () => {
    const { registry } = makeRegistry();
    for (const name of ["markPaymentPaid", "transitionApprovalStatus", "transitionPaymentStatus", "transitionOrderStatus"]) {
      const result = await registry.executeByName(name, {}, CTX);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.category, "INVALID_INPUT");
    }
  });

  it("delegates a known name to the same behavior as execute()", async () => {
    const rfq = makeRfq();
    const { registry } = makeRegistry({ rfq: { getRfqById: async () => rfq } });

    const result = await registry.executeByName("get_rfq", { rfqId: "rfq-1" }, CTX);

    assert.deepEqual(result, { ok: true, data: rfq });
  });
});

describe("boundary integrity: static properties of tools.ts's own source (Step 19)", () => {
  const source = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
  // Strip comments AND string/template literal contents before scanning:
  // the file's own top-of-file doc comment deliberately *names*
  // markPaymentPaid/transitionPaymentStatus/transitionApprovalStatus in
  // prose to explain why they are never called, and TOOL_REGISTRY's own
  // `approvalBehavior` documentation string for request_approval likewise
  // *names* transitionApprovalStatus() in prose (Step 5 requires every tool
  // to self-document this way; it's data, not a call). So the meaningful
  // assertion is "never referenced as an actual identifier in executable
  // code", not "never mentioned anywhere in the file, comment or string".
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

  it("never calls the two Payment capabilities that would let the agent declare a payment PAID", () => {
    assert.ok(!codeOnly.includes("markPaymentPaid"), "tools.ts code must never call PaymentApplication.markPaymentPaid()");
    assert.ok(
      !codeOnly.includes("transitionPaymentStatus"),
      "tools.ts code must never call PaymentApplication.transitionPaymentStatus()",
    );
  });

  it("never calls ApprovalApplication.transitionApprovalStatus -- self-approval is structurally impossible, not just policy-forbidden", () => {
    assert.ok(!codeOnly.includes("transitionApprovalStatus"));
  });

  it("contains no raw Supabase table access -- every handler delegates to an application-layer method only", () => {
    assert.ok(!codeOnly.includes(".from("), "no handler may call `.from(table)` directly");
    assert.ok(!codeOnly.includes(".update("), "no handler may call `.update(...)` directly");
  });

  it("contains no Razorpay reference in actual code -- payment-provider calls stay behind the Payment application layer", () => {
    assert.ok(!/razorpay/i.test(codeOnly), "tools.ts code (outside comments) must not reference Razorpay");
  });

  it("createSupabaseToolRegistry composes exactly the six approved application-layer factories", () => {
    for (const factory of [
      "createSupabaseRfqApplication",
      "createSupabaseQuoteApplication",
      "createSupabaseOrderApplication",
      "createSupabasePaymentApplication",
      "createSupabasePolicyApplication",
      "createSupabaseApprovalApplication",
    ]) {
      assert.ok(codeOnly.includes(factory), `expected tools.ts to compose ${factory}`);
    }
  });
});

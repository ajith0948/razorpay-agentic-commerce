import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createToolRegistry, TOOL_NAMES } from "./tools.ts";
import type { ToolDeps } from "./tools.ts";
import { FakeStatusDb } from "../state-machine/test-support.ts";
import { buildAgentToolDefinitions } from "./tool-definitions.ts";

/**
 * lib/agent/tool-definitions.test.ts -- proves buildAgentToolDefinitions()
 * faithfully reflects the real Tool Registry: one definition per real tool
 * name, every Zod inputSchema converts without throwing, and the resulting
 * JSON Schema's structure (required fields, empty-object schemas) matches
 * what tools.ts's own Zod schemas actually declare.
 *
 * Built against a *real* createToolRegistry() (not a hand-copied duplicate
 * of TOOL_REGISTRY, which tools.ts deliberately does not export) so this
 * test exercises the same object production code uses. Every ToolDeps
 * method is an unreachable stub: this file never calls execute()/
 * executeByName(), only reads the registry's static toolNames/definitions,
 * so no handler ever runs. Same "unreachable-stub" discipline as
 * tools.test.ts and session.test.ts.
 */

function notImplemented(method: string): never {
  throw new Error(`test fake: ${method}() should not be called by this test`);
}

function makeToolDeps(): ToolDeps {
  return {
    rfq: {
      createRfq: () => notImplemented("createRfq"),
      getRfqById: () => notImplemented("getRfqById"),
      transitionRfqStatus: () => notImplemented("transitionRfqStatus"),
      processRfqRequirements: () => notImplemented("processRfqRequirements"),
    },
    quote: {
      createQuote: () => notImplemented("createQuote"),
      getQuoteById: () => notImplemented("getQuoteById"),
      transitionQuoteStatus: () => notImplemented("transitionQuoteStatus"),
    },
    order: {
      createOrder: () => notImplemented("createOrder"),
      getOrderById: () => notImplemented("getOrderById"),
      transitionOrderStatus: () => notImplemented("transitionOrderStatus"),
    },
    payment: {
      createPayment: () => notImplemented("createPayment"),
      getPaymentById: () => notImplemented("getPaymentById"),
      transitionPaymentStatus: () => notImplemented("transitionPaymentStatus"),
      markPaymentPaid: () => notImplemented("markPaymentPaid"),
    },
    policy: {
      getActiveMerchantPolicy: () => notImplemented("getActiveMerchantPolicy"),
      evaluate: () => notImplemented("evaluate"),
    },
    approval: {
      createApproval: () => notImplemented("createApproval"),
      getApprovalById: () => notImplemented("getApprovalById"),
      getLatestApprovalByQuoteId: () => notImplemented("getLatestApprovalByQuoteId"),
      transitionApprovalStatus: () => notImplemented("transitionApprovalStatus"),
    },
  };
}

function makeRealRegistry() {
  return createToolRegistry({ ...makeToolDeps(), auditDb: new FakeStatusDb() });
}

describe("buildAgentToolDefinitions", () => {
  it("produces exactly one definition per real tool name", () => {
    const registry = makeRealRegistry();
    const defs = buildAgentToolDefinitions(registry);
    assert.deepEqual(
      defs.map((d) => d.name).sort(),
      [...TOOL_NAMES].sort(),
    );
  });

  it("uses each tool's `purpose` string as its description, non-empty", () => {
    const registry = makeRealRegistry();
    const defs = buildAgentToolDefinitions(registry);
    for (const def of defs) {
      assert.equal(typeof def.description, "string");
      assert.ok(def.description.length > 0, `${def.name} must have a non-empty description`);
    }
  });

  it("converts every real tool's Zod inputSchema to JSON Schema without throwing", () => {
    const registry = makeRealRegistry();
    // buildAgentToolDefinitions() itself would already throw if any
    // schema failed to convert; this test's real assertion is the
    // structural spot-checks below.
    const defs = buildAgentToolDefinitions(registry);
    for (const def of defs) {
      assert.equal(def.inputSchema.type, "object");
      assert.equal(typeof def.inputSchema.properties, "object");
    }
  });

  it("get_rfq's schema requires rfqId as a string", () => {
    const registry = makeRealRegistry();
    const def = buildAgentToolDefinitions(registry).find((d) => d.name === "get_rfq");
    assert.ok(def);
    assert.deepEqual(def.inputSchema.required, ["rfqId"]);
    const props = def.inputSchema.properties as Record<string, { type?: string }>;
    assert.equal(props.rfqId?.type, "string");
  });

  it("get_merchant_policy's schema has no required fields (its Zod schema is z.object({}))", () => {
    const registry = makeRealRegistry();
    const def = buildAgentToolDefinitions(registry).find((d) => d.name === "get_merchant_policy");
    assert.ok(def);
    assert.equal(def.inputSchema.type, "object");
    assert.deepEqual(def.inputSchema.properties, {});
    assert.ok(!("required" in def.inputSchema) || (def.inputSchema.required as unknown[]).length === 0);
  });

  it("create_quote's schema marks optional fields (discountPercent, validUntil) as not required", () => {
    const registry = makeRealRegistry();
    const def = buildAgentToolDefinitions(registry).find((d) => d.name === "create_quote");
    assert.ok(def);
    const required = def.inputSchema.required as string[];
    assert.ok(required.includes("rfqId"));
    assert.ok(required.includes("totalAmount"));
    assert.ok(!required.includes("discountPercent"));
    assert.ok(!required.includes("validUntil"));
  });

  it("validate_policy's schema has every field optional (no required array entries)", () => {
    const registry = makeRealRegistry();
    const def = buildAgentToolDefinitions(registry).find((d) => d.name === "validate_policy");
    assert.ok(def);
    const required = (def.inputSchema.required as string[] | undefined) ?? [];
    assert.equal(required.length, 0);
  });
});

/**
 * Converts an RFQ's free-text raw_request into the structured requirements
 * DATABASE.md section 8 describes: quantity, product requirements,
 * dimensions, material, printing, delivery location, delivery deadline,
 * budget. The concrete JSON key names below (quantity/product/dimensions/
 * material/printing/destination/deadline/budget) follow
 * IMPLEMENTATION_PLAN.md's own worked "Expected structure" example for this
 * exact input shape (doc-Phase-10, "RFQ Parsing") -- the only place the
 * docs give an exact key-level contract; DATABASE.md section 8 lists these
 * only as category labels, not JSON keys.
 *
 * RequirementsParser is a narrow interface, not a concrete class, so this
 * phase's deterministic implementation is a pure dependency-injection swap
 * for a future LLM-backed one. IMPLEMENTATION_PLAN.md doc-Phase-10 task 1
 * ("Connect Gemini API") is explicitly out of this implementation phase's
 * scope -- AGENTS.md section 4 ("Understand natural-language RFQs") and
 * ARCHITECTURE.md section 2 ("LLM: Understand requests") are that
 * capability's eventual home, gated behind the Agent layer this phase does
 * not build. parse() is declared async even though this implementation is
 * internally synchronous, precisely so that future swap requires no
 * call-site change anywhere in application.ts.
 *
 * ARCHITECTURE.md section 18's Agent tool sequence ("1. Parse requirements
 * 2. Search catalog ...") frames parsing as one of the agent's own steps;
 * that does not make this module premature Agent-layer work. It is the
 * reverse dependency: a later Agent-layer "parse_requirements" tool would
 * be a thin wrapper calling this same RequirementsParser (or its future
 * LLM-backed replacement), exactly like RfqDbClient/StatusDbClient are
 * already narrow ports other layers depend on rather than reimplement. This
 * phase builds the capability; a later phase may additionally expose it as
 * an agent tool.
 *
 * quantity and product are the only two fields this parser treats as
 * required. ARCHITECTURE.md section 26 ("RFQ Failure") names exactly these
 * two as its own worked examples of RFQ failure ("Missing quantity",
 * "Missing product requirements"), and DATABASE.md's quote-pricing model
 * (base_price x quantity, minimum_quantity checks -- section 11) cannot
 * proceed without either. The other five fields are quote-shaping
 * modifiers a later Quote phase can treat as absent/null, exactly like the
 * schema's own unconstrained `structured_requirements jsonb` column (no
 * CHECK constraint requires any particular key -- see the Phase 1 migration
 * comment quoted in application.ts/types.ts).
 *
 * `product` extraction is a deliberately small keyword classifier against
 * this MVP's one demo vertical (AGENTS.md: "Demo vertical: Custom
 * packaging"; the exact category labels seeded in supabase/seed.sql --
 * "Corrugated Boxes", "Custom Printed Boxes", "Mailers"), not a general
 * NLP/product-recognition system -- building the latter now would be
 * exactly the "overengineering before MVP functionality exists" AGENTS.md
 * section 11 warns against, and it is squarely what task 1's future Gemini
 * integration is for. "boxes" -> "corrugated box" mirrors doc-Phase-10's
 * own worked example verbatim.
 *
 * Known deterministic-parser limitation (documented, not hidden): every
 * worked example across AGENTS.md/ARCHITECTURE.md/DATABASE.md/
 * IMPLEMENTATION_PLAN.md states quantity first ("5,000 5-ply boxes, ..."),
 * so this implementation takes the first number in raw_request as the
 * quantity. A request that leads with an unrelated number (e.g. a delivery
 * deadline stated before the quantity) would misparse. This is exactly the
 * class of ambiguity a future model-backed implementation is better suited
 * to resolve; it is not attempted here.
 */

import { z } from "zod";
import { RfqRequirementsParsingError } from "./errors.ts";

/**
 * The parsed shape this phase's parser promises to produce. Deliberately a
 * concrete, separate type from Rfq.structuredRequirements's own
 * `Record<string, unknown> | null` (types.ts) -- that field's generic shape
 * is the schema/domain-type contract every future parser (this one or a
 * later LLM-backed one) must be assignable to, not a type this specific
 * implementation should narrow the schema down to.
 */
export interface ParsedRfqRequirements {
  quantity: number;
  product: string;
  dimensions: string | null;
  material: string | null;
  printing: string | null;
  destination: string | null;
  deadline: string | null;
  budget: number | null;
}

/**
 * Runtime shape validator for a parser's output -- IMPLEMENTATION_PLAN.md
 * doc-Phase-10 task 3, "Validate output using Zod". Applies equally to this
 * phase's deterministic parser and to a future LLM-backed one: a model's
 * JSON output needs exactly this same safety net, so proving it out against
 * the deterministic implementation now means swapping in a model later adds
 * no new validation code.
 */
export const ParsedRfqRequirementsSchema = z.object({
  quantity: z.number().positive(),
  product: z.string().min(1),
  dimensions: z.string().min(1).nullable(),
  material: z.string().min(1).nullable(),
  printing: z.string().min(1).nullable(),
  destination: z.string().min(1).nullable(),
  deadline: z.string().min(1).nullable(),
  budget: z.number().positive().nullable(),
});

/**
 * The seam a future LLM-backed implementation replaces (see module doc
 * comment). Anything implementing this interface is a valid `parser`
 * dependency for createRfqApplication() (application.ts).
 */
export interface RequirementsParser {
  /**
   * Throws RfqRequirementsParsingError if quantity and/or product cannot be
   * determined from rawRequest. Never resolves to a value that fails
   * ParsedRfqRequirementsSchema.
   */
  parse(rawRequest: string): Promise<ParsedRfqRequirements>;
}

/** First number in the text -- see the module doc comment's documented limitation. */
function extractQuantity(text: string): number | null {
  const match = text.match(/\d{1,3}(?:,\d{3})+|\d+/);
  if (!match) return null;
  const n = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const PRODUCT_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bmailers?\b/i, "mailer"],
  [/\b(?:custom[- ]printed|printed)\s+(?:boxes?|cartons?)\b/i, "custom printed box"],
  [/\bboxes?\b/i, "corrugated box"],
  [/\bcartons?\b/i, "corrugated box"],
];

function extractProduct(text: string): string | null {
  for (const [pattern, label] of PRODUCT_KEYWORDS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

function extractDimensions(text: string): string | null {
  const match = text.match(/\b(\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?)\b/i);
  return match ? match[1].replace(/\s+/g, "") : null;
}

function extractMaterial(text: string): string | null {
  const match = text.match(/\b(\d+)[- ]ply\b/i);
  return match ? `${match[1]}-ply` : null;
}

function extractPrinting(text: string): string | null {
  const match = text.match(/\b(\d+)[- ](colou?r)\b/i);
  return match ? `${match[1]}-${match[2].toLowerCase()}` : null;
}

function extractDestination(text: string): string | null {
  const match = text.match(
    /\bdeliver(?:ed|y)?\s*(?:to)?\s+([A-Za-z][A-Za-z\s]*?)(?=\s+within\b|\s*[,.]|$)/i,
  );
  return match ? match[1].trim() : null;
}

function extractDeadline(text: string): string | null {
  const match = text.match(/\bwithin\s+(\d+\s*(?:days|day|weeks|week|months|month))\b/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}

function extractBudget(text: string): number | null {
  // "budget ₹120,000" / "under ₹120,000" / "budget of Rs.120000" / "₹120,000 budget"
  const forward = text.match(/(?:budget|under)[^₹\d]{0,12}(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/i);
  const backward = text.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)[^\d]{0,12}budget/i);
  const raw = forward?.[1] ?? backward?.[1];
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * This phase's deterministic implementation -- regex-based extraction, no
 * network call, no dependency beyond Zod (already required for output
 * validation). Grounded entirely in the demo vertical's own worked example
 * reused verbatim across AGENTS.md/ARCHITECTURE.md/DATABASE.md/
 * IMPLEMENTATION_PLAN.md: "I need 5,000 5-ply boxes, 18x12x10, with a
 * 2-color logo, deliver to Chennai within 10 days, budget ₹120,000."
 */
export function createDeterministicRequirementsParser(): RequirementsParser {
  return {
    async parse(rawRequest: string): Promise<ParsedRfqRequirements> {
      const quantity = extractQuantity(rawRequest);
      const product = extractProduct(rawRequest);

      // Checked together (rather than two separate `if (x === null) throw`
      // guards) so both missing fields are reported in one
      // RfqRequirementsParsingError instead of only ever surfacing the
      // first -- ARCHITECTURE.md section 26's "Ask the buyer for the
      // missing information" is more useful when it can ask for everything
      // missing at once. This form is also what lets TypeScript narrow
      // `quantity`/`product` to their non-null types below: control-flow
      // analysis can follow a direct `=== null` check on the two variables
      // themselves, unlike a check on a separately-populated array's
      // `.length`.
      if (quantity === null || product === null) {
        const missingFields: string[] = [];
        if (quantity === null) missingFields.push("quantity");
        if (product === null) missingFields.push("product");
        throw new RfqRequirementsParsingError(missingFields);
      }

      const parsed: ParsedRfqRequirements = {
        quantity,
        product,
        dimensions: extractDimensions(rawRequest),
        material: extractMaterial(rawRequest),
        printing: extractPrinting(rawRequest),
        destination: extractDestination(rawRequest),
        deadline: extractDeadline(rawRequest),
        budget: extractBudget(rawRequest),
      };

      return ParsedRfqRequirementsSchema.parse(parsed);
    },
  };
}

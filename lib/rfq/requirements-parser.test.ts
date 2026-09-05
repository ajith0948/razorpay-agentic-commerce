import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createDeterministicRequirementsParser,
  ParsedRfqRequirementsSchema,
} from "./requirements-parser.ts";
import { RfqRequirementsParsingError } from "./errors.ts";

const parser = createDeterministicRequirementsParser();

describe("createDeterministicRequirementsParser: happy path", () => {
  it("parses the canonical worked example (AGENTS.md/ARCHITECTURE.md/DATABASE.md/IMPLEMENTATION_PLAN.md) into every field", async () => {
    const result = await parser.parse(
      "I need 5,000 5-ply boxes, 18x12x10, with a 2-color logo, deliver to " +
        "Chennai within 10 days, budget ₹120,000.",
    );

    assert.deepEqual(result, {
      quantity: 5000,
      product: "corrugated box",
      dimensions: "18x12x10",
      material: "5-ply",
      printing: "2-color",
      destination: "Chennai",
      deadline: "10 days",
      budget: 120000,
    });
  });

  it("returns a result that satisfies ParsedRfqRequirementsSchema", async () => {
    const result = await parser.parse("Need 200 mailers");
    assert.doesNotThrow(() => ParsedRfqRequirementsSchema.parse(result));
  });

  it("is deterministic: parsing the same input twice yields identical output", async () => {
    const input = "Need 5000 5-ply boxes, 18x12x10, deliver to Pune within 2 weeks, budget Rs.90000";
    const first = await parser.parse(input);
    const second = await parser.parse(input);
    assert.deepEqual(first, second);
  });

  it("leaves optional fields null when only quantity and product are present", async () => {
    const result = await parser.parse("We need 250 mailers for a mailing campaign.");
    assert.equal(result.quantity, 250);
    assert.equal(result.product, "mailer");
    assert.equal(result.dimensions, null);
    assert.equal(result.material, null);
    assert.equal(result.printing, null);
    assert.equal(result.destination, null);
    assert.equal(result.deadline, null);
    assert.equal(result.budget, null);
  });

  it("recognizes plain 'boxes'/'cartons' as a corrugated box", async () => {
    const boxes = await parser.parse("Need 100 boxes");
    assert.equal(boxes.product, "corrugated box");
    const cartons = await parser.parse("Need 100 cartons");
    assert.equal(cartons.product, "corrugated box");
  });

  it("parses an alternate currency format ('Rs.' with 'budget of')", async () => {
    const result = await parser.parse("Need 300 mailers, budget of Rs.45000");
    assert.equal(result.budget, 45000);
  });

  it("parses a budget stated before the 'budget' keyword (₹ amount then 'budget')", async () => {
    const result = await parser.parse("Need 300 mailers, ₹50,000 budget");
    assert.equal(result.budget, 50000);
  });

  it("parses an 'under <amount>' budget phrasing", async () => {
    const result = await parser.parse("Need 300 mailers, under ₹75000");
    assert.equal(result.budget, 75000);
  });
});

describe("createDeterministicRequirementsParser: required-field failures", () => {
  it("throws RfqRequirementsParsingError with missingFields=['quantity'] when no number is present", async () => {
    await assert.rejects(
      () => parser.parse("We need custom printed boxes for our upcoming launch"),
      (err: unknown) => {
        assert.ok(err instanceof RfqRequirementsParsingError);
        assert.deepEqual(err.missingFields, ["quantity"]);
        return true;
      },
    );
  });

  it("throws RfqRequirementsParsingError with missingFields=['product'] when no product keyword matches", async () => {
    await assert.rejects(
      () => parser.parse("We need 500 units for our next event"),
      (err: unknown) => {
        assert.ok(err instanceof RfqRequirementsParsingError);
        assert.deepEqual(err.missingFields, ["product"]);
        return true;
      },
    );
  });

  it("throws RfqRequirementsParsingError with both fields missing for empty input", async () => {
    await assert.rejects(
      () => parser.parse(""),
      (err: unknown) => {
        assert.ok(err instanceof RfqRequirementsParsingError);
        assert.deepEqual(err.missingFields, ["quantity", "product"]);
        return true;
      },
    );
  });

  it("throws RfqRequirementsParsingError with both fields missing for whitespace-only input", async () => {
    await assert.rejects(
      () => parser.parse("   \n\t  "),
      (err: unknown) => {
        assert.ok(err instanceof RfqRequirementsParsingError);
        assert.deepEqual(err.missingFields, ["quantity", "product"]);
        return true;
      },
    );
  });

  it("throws RfqRequirementsParsingError for unrelated free text", async () => {
    await assert.rejects(
      () => parser.parse("Please call me back about our account."),
      RfqRequirementsParsingError,
    );
  });
});

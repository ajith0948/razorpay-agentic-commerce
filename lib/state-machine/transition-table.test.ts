import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertValidTransition, isValidTransition, type TransitionTable } from "./transition-table.ts";
import { InvalidTransitionError } from "./errors.ts";

type TrafficLight = "RED" | "YELLOW" | "GREEN";

const LIGHT: TransitionTable<TrafficLight> = {
  RED: ["GREEN"],
  GREEN: ["YELLOW"],
  YELLOW: ["RED"],
};

describe("isValidTransition", () => {
  it("returns true for an edge present in the table", () => {
    assert.equal(isValidTransition(LIGHT, "RED", "GREEN"), true);
  });

  it("returns false for an edge absent from the table", () => {
    assert.equal(isValidTransition(LIGHT, "RED", "YELLOW"), false);
  });

  it("returns false for a self-transition that isn't explicitly listed", () => {
    assert.equal(isValidTransition(LIGHT, "RED", "RED"), false);
  });
});

describe("assertValidTransition", () => {
  it("does not throw for a valid edge", () => {
    assert.doesNotThrow(() => assertValidTransition("Light", LIGHT, "GREEN", "YELLOW"));
  });

  it("throws InvalidTransitionError with entity/from/to for an invalid edge", () => {
    try {
      assertValidTransition("Light", LIGHT, "RED", "YELLOW");
      assert.fail("expected assertValidTransition to throw");
    } catch (err) {
      assert.ok(err instanceof InvalidTransitionError);
      assert.equal(err.entity, "Light");
      assert.equal(err.from, "RED");
      assert.equal(err.to, "YELLOW");
    }
  });

  it("throws for every transition out of a state with no outgoing edges", () => {
    const TERMINAL: TransitionTable<TrafficLight> = { RED: [], GREEN: [], YELLOW: [] };
    assert.throws(() => assertValidTransition("Light", TERMINAL, "RED", "GREEN"), InvalidTransitionError);
  });
});

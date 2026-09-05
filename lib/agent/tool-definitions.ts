/**
 * Converts the real Agent Tool Registry (tools.ts) into the vendor-neutral
 * AgentToolDefinition[] shape (model-provider.ts) that gets handed to an
 * LLM provider as its tool catalog.
 *
 * Tool schemas must come from the existing tool contracts, not a
 * hand-maintained second copy that can drift from them -- this file's only
 * real logic is z.toJSONSchema(def.inputSchema), Zod v4's own native
 * schema-to-JSON-Schema converter (already a project dependency; no new
 * package). `purpose` (already required, non-empty prose on every
 * ToolDefinition -- see tools.test.ts's "every tool definition carries Step
 * 5's full documentation" check) becomes the tool's `description`.
 *
 * Deliberately takes only the two static fields it reads (`toolNames`,
 * `definitions`), not the full ToolRegistry -- this function never executes
 * a tool, so it has no business depending on `execute`/`executeByName`.
 */

import { z } from "zod";
import type { ToolRegistry } from "./tools.ts";
import type { AgentToolDefinition } from "./model-provider.ts";

export function buildAgentToolDefinitions(
  registry: Pick<ToolRegistry, "toolNames" | "definitions">,
): AgentToolDefinition[] {
  return registry.toolNames.map((name) => {
    const def = registry.definitions[name];
    return {
      name: def.name,
      description: def.purpose,
      inputSchema: z.toJSONSchema(def.inputSchema) as Record<string, unknown>,
    };
  });
}

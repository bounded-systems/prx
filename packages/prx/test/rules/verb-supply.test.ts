// GH-1423 PR-1: verb-supply loader projects `prxCommandRegistry`.

import { describe, expect, test } from "bun:test";

import { prxCommandRegistry } from "../../src/cli/registry.data.ts";
import { loadVerbSupply } from "../../src/rules/loaders/verb-supply.ts";
import { verbSupplySchema } from "../../src/rules/schemas/inputs.ts";

describe("loadVerbSupply", () => {
  test("emits one entry per CommandSpec in the registry", () => {
    const supply = loadVerbSupply();
    expect(supply.length).toBe(prxCommandRegistry.length);
  });

  test("each entry round-trips against the Zod schema", () => {
    const supply = loadVerbSupply();
    expect(() => verbSupplySchema.parse(supply)).not.toThrow();
  });

  test("the `rules render` entry is included (self-coverage)", () => {
    const supply = loadVerbSupply();
    const entry = supply.find((v) => v.name === "rules render");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("rules");
    expect(entry!.parent).toBe("rules");
  });

  test("preserves actor identity across the projection", () => {
    const supply = loadVerbSupply();
    for (const spec of prxCommandRegistry) {
      const entry = supply.find((v) => v.name === spec.name);
      expect(entry, `'${spec.name}' missing from supply`).toBeDefined();
      expect(entry!.actor).toBe(spec.actor);
      expect(entry!.parent).toBe(spec.parent);
    }
  });
});

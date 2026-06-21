// Forcing function for the agentic-hygiene doctrine itself.
//
// docs/agentic-code-hygiene.md claims eight self-check layers, and the doctrine's
// own rule is that a property isn't real unless a tool/test enforces it. So this
// test enforces the doctrine: every layer must have at least one LIVE gate on
// disk, and the doc must document every layer this test enforces. Delete a gate
// (or drop a layer from the doc) and the matching case fails — the doc can't
// out-run the code, and a self-check layer can't be silently removed.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "../../src/repo-root.ts";

const ROOT = findRepoRoot();
const DOCTRINE = "docs/agentic-code-hygiene.md";

const has = (rel: string): boolean => existsSync(join(ROOT, rel));
const anyMatch = (pattern: string): boolean =>
  Array.from(new Bun.Glob(pattern).scanSync({ cwd: ROOT })).length > 0;
const hasScript = (name: string): boolean => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return name in (pkg.scripts ?? {});
};

/** Each self-check layer → the gate(s) that enforce it on disk. */
const LAYERS: ReadonlyArray<{ n: number; name: string; gate: () => boolean }> = [
  { n: 1, name: "Shape & style", gate: () => has("biome.jsonc") && hasScript("lint") },
  { n: 2, name: "Liveness", gate: () => has("knip.json") },
  {
    n: 3,
    name: "Structure",
    gate: () => has(".dependency-cruiser.cjs") && has("packages/prx/test/code_health.test.ts"),
  },
  {
    n: 4,
    name: "Capability & safety",
    gate: () =>
      has("packages/prx/test/architecture/ambient-authority-guard.test.ts") &&
      anyMatch("packages/*/src/__tests__/extractability.test.ts"),
  },
  {
    n: 5,
    name: "Behavior",
    gate: () => anyMatch("features/*.feature") && has("packages/prx/test/value_props.test.ts"),
  },
  {
    n: 6,
    name: "Truth",
    gate: () =>
      hasScript("docs:check") && anyMatch("packages/prx/test/architecture/*-fresh.test.ts"),
  },
  {
    n: 7,
    name: "History",
    gate: () => has(".changeset/config.json") && has(".github/workflows/changeset-check.yml"),
  },
  {
    n: 8,
    name: "Self-report",
    gate: () =>
      has("packages/prx/scripts/code-health.ts") && has("packages/prx/src/health/verb.ts"),
  },
];

describe("agentic-hygiene doctrine — every self-check layer has a live gate", () => {
  for (const layer of LAYERS) {
    test(`layer ${layer.n} (${layer.name}) is enforced by a gate on disk`, () => {
      expect(
        layer.gate(),
        `layer ${layer.n} (${layer.name}) has no live gate — restore it or update ${DOCTRINE}`,
      ).toBe(true);
    });
  }

  test("the doctrine doc documents every enforced layer", () => {
    const doc = readFileSync(join(ROOT, DOCTRINE), "utf8");
    const undocumented = LAYERS.filter((l) => !doc.includes(l.name)).map((l) => l.name);
    expect(undocumented, `${DOCTRINE} is missing layers this test enforces`).toEqual([]);
    expect(LAYERS.length, "the doctrine is an eight-layer model").toBe(8);
  });
});

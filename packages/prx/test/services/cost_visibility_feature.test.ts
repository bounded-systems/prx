// Drift + faithfulness for features/cost-visibility.feature. The committed
// feature must match the generator, and the REAL projector (projectAnthropicUsage
// over an in-memory ledger seeded with the fixture) must equal the declared
// per-unit aggregate — so the gherkin can't claim cost visibility the code
// doesn't deliver.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "../../src/repo-root.ts";
import {
  EXPECTED_BY_UNIT,
  generateCostVisibilityFeature,
  perUnitCostIsVisible,
  projectFixtureByUnit,
} from "../../src/services/cost_visibility_feature.ts";

const featurePath = join(findRepoRoot(), "features", "cost-visibility.feature");

describe("cost-visibility .feature", () => {
  test("the committed feature matches the generator (no drift)", () => {
    expect(existsSync(featurePath)).toBe(true);
    expect(readFileSync(featurePath, "utf8")).toBe(generateCostVisibilityFeature());
  });

  test("FAITHFUL: the real projector aggregates the fixture to the declared per-unit cost", () => {
    expect(projectFixtureByUnit()).toEqual([...EXPECTED_BY_UNIT]);
  });

  test('FAITHFUL: unattached usage groups as "(unattached)"', () => {
    expect(projectFixtureByUnit().some((b) => b.bucket === "(unattached)")).toBe(true);
  });

  test("the value-prop check is green", () => {
    expect(perUnitCostIsVisible()).toBe(true);
  });
});

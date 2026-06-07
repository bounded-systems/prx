// Drift + faithfulness for features/derivation-chain.feature. The committed
// feature must match the generator, and every scenario must hold against the REAL
// anchored-chain digest behavior — so the gherkin can't claim a content-addressing
// property the code doesn't deliver.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalJson,
  digestManifest,
  manifestToStatement,
  statementToManifest,
} from "@bounded-systems/anchored-chain";

import { findRepoRoot } from "../../src/repo-root.ts";
import {
  BASELINE_MANIFEST,
  MANIFEST_FIELDS,
  generateDerivationChainFeature,
  mutatedManifest,
} from "../../src/provenance/derivation_chain_feature.ts";

const featurePath = join(findRepoRoot(), "features", "derivation-chain.feature");

describe("derivation-chain .feature", () => {
  test("the committed feature matches the generator (no drift)", () => {
    expect(existsSync(featurePath)).toBe(true);
    expect(readFileSync(featurePath, "utf8")).toBe(generateDerivationChainFeature());
  });

  test("FAITHFUL: changing any manifest field changes the derivation id", () => {
    const base = digestManifest(BASELINE_MANIFEST);
    for (const field of MANIFEST_FIELDS) {
      expect(digestManifest(mutatedManifest(field)), `field "${field}" did not change the id`).not.toBe(base);
    }
  });

  test("FAITHFUL: the id is deterministic across repeated calls", () => {
    expect(digestManifest(BASELINE_MANIFEST)).toBe(digestManifest(BASELINE_MANIFEST));
  });

  test("FAITHFUL: reordering keys does not change the canonical JSON (or the id)", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("FAITHFUL: a manifest round-trips through its in-toto statement", () => {
    const recovered = statementToManifest(manifestToStatement(BASELINE_MANIFEST));
    expect(canonicalJson(recovered)).toBe(canonicalJson(BASELINE_MANIFEST));
  });
});

// Canonical work-unit-id helpers (GH-1536/GH-1674/GH-2098) — the branches the
// existing work_unit.test.ts leaves uncovered: isCanonical, require-throw,
// directory/branch derivation, and the generic helper builder's parse.

import { describe, expect, test } from "bun:test";

import {
  buildCanonicalWorkUnitIdHelpers,
  canonicalWorkUnitIdFromBranchName,
  canonicalWorkUnitIdFromDirectory,
  isCanonicalWorkUnitId,
  normalizeCanonicalWorkUnitId,
  requireCanonicalWorkUnitId,
} from "../../src/machine/work_unit.ts";

describe("canonical work-unit id helpers (uncovered arms)", () => {
  test("isCanonicalWorkUnitId matches the canonical shape", () => {
    expect(isCanonicalWorkUnitId("GH-456")).toBe(true);
    expect(isCanonicalWorkUnitId("not-an-id")).toBe(false);
  });

  test("require returns the id or throws with a helpful message", () => {
    // Branded WorkUnitId — compare the underlying string value.
    expect(requireCanonicalWorkUnitId("GH-7") as string).toBe("GH-7");
    expect(() => requireCanonicalWorkUnitId("bogus")).toThrow(/canonical issue id format/);
    expect(() => requireCanonicalWorkUnitId("bogus", "branch")).toThrow(/^branch must match/);
  });

  test("derive from a branch name / directory basename (and reject empty)", () => {
    expect(canonicalWorkUnitIdFromBranchName("GH-9") as string).toBe("GH-9");
    expect(canonicalWorkUnitIdFromBranchName(null)).toBeNull();
    expect(canonicalWorkUnitIdFromDirectory("/wt/GH-9") as string).toBe("GH-9");
    expect(canonicalWorkUnitIdFromDirectory("   ")).toBeNull(); // empty/blank guard
    expect(canonicalWorkUnitIdFromDirectory(null)).toBeNull();
  });
});

describe("buildCanonicalWorkUnitIdHelpers", () => {
  const h = buildCanonicalWorkUnitIdHelpers(/^GH-\d+$/);

  test("exposes the pattern + normalize", () => {
    expect(h.pattern.source).toBe("^GH-\\d+$");
    expect(h.normalize(" gh-1 ")).toBe("GH-1");
  });

  test("isCanonical + case-preserving parse arms", () => {
    expect(h.isCanonical("GH-1")).toBe(true);
    expect(h.parse("GH-1")).toBe("GH-1"); // verbatim
    expect(h.parse("gh-1")).toBe("GH-1"); // case-folded retry
    expect(h.parse("  ")).toBeNull(); // blank guard
    expect(h.parse("nope")).toBeNull(); // no match either case
    expect(h.parse(null)).toBeNull(); // non-string guard
  });

  test("normalizeCanonicalWorkUnitId trims + uppercases", () => {
    expect(normalizeCanonicalWorkUnitId("  gh-2 ")).toBe("GH-2");
  });
});

import { describe, expect, test } from "bun:test";

import { buildCanonicalIdScanner, extractCanonicalRefs } from "../../src/submit/extract-refs.ts";
import { canonicalWorkUnitIdPattern } from "../../src/machine/work_unit.ts";
import type { IdentityConfig } from "../../src/pr-state/github.ts";

const defaultIdentity: IdentityConfig = {
  sources: {
    github: {
      name: "github",
      kind: "github",
      canonicalIdPattern: canonicalWorkUnitIdPattern,
      source: "<test>",
    },
  },
  defaultSourceName: "github",
  isDefault: true,
};

function customIdentity(pattern: RegExp): IdentityConfig {
  return {
    sources: {
      github: {
        name: "github",
        kind: "github",
        canonicalIdPattern: pattern,
        source: "<test>",
      },
    },
    defaultSourceName: "github",
    isDefault: false,
  };
}

describe("extractCanonicalRefs — default identity", () => {
  test("returns [] on empty / null input", () => {
    expect(extractCanonicalRefs("", defaultIdentity)).toEqual([]);
    expect(extractCanonicalRefs(null, defaultIdentity)).toEqual([]);
    expect(extractCanonicalRefs(undefined, defaultIdentity)).toEqual([]);
  });

  test("extracts GH-N references in source order", () => {
    const blob = "fix(submit): close (GH-1318) sweeps GH-885 and GH-882";
    expect(extractCanonicalRefs(blob, defaultIdentity)).toEqual(["GH-1318", "GH-885", "GH-882"]);
  });

  test("dedupes case-insensitively, preserves first-seen casing", () => {
    const blob = "GH-100 referenced again as gh-100 and once more as GH-100";
    expect(extractCanonicalRefs(blob, defaultIdentity)).toEqual(["GH-100"]);
  });

  test("extracts mixed canonical surfaces (GH/NOTION)", () => {
    const blob = "linked: GH-456 NOTION-1234567890abcdef1234567890abcdef";
    const out = extractCanonicalRefs(blob, defaultIdentity);
    expect(out).toContain("GH-456");
    expect(out).toContain("NOTION-1234567890abcdef1234567890abcdef");
  });

  test("does not match decorative-looking but non-canonical strings", () => {
    expect(extractCanonicalRefs("GH-abc and GHX-1", defaultIdentity)).toEqual([]);
  });
});

describe("buildCanonicalIdScanner — identity overlay", () => {
  test("respects a custom canonicalIdPattern (GH-only override)", () => {
    const identity = customIdentity(/^GH-\d+$/);
    const blob = "GH-1 and BD-DEADBEEF and NOTION-1234567890abcdef1234567890abcdef";
    expect(extractCanonicalRefs(blob, identity)).toEqual(["GH-1"]);
  });

  test("scanner is global + case-insensitive", () => {
    const scanner = buildCanonicalIdScanner(defaultIdentity);
    expect(scanner.flags).toContain("g");
    expect(scanner.flags).toContain("i");
  });
});

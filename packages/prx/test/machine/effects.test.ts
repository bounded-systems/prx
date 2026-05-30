import { describe, expect, test } from "bun:test";

import {
  ALL_SURFACES,
  Surface,
  VerbEffects,
  isReadOnly,
  touchedSurfaces,
} from "../../src/machine/effects.ts";

// GH-2438 / ai-home-mqlno — the effect-trait contract (the Zod form of the CUE
// #Surface/#Verb model). Tests pin Rule 4 (one write surface per verb) at the
// schema layer; conforming CommandSpec to carry these is the later slice.

describe("Surface", () => {
  test("enumerates the backing stores from spec/prx/schema.cue", () => {
    expect(new Set(ALL_SURFACES)).toEqual(
      new Set(["github", "beads", "dolt", "notion", "filesystem", "cas", "tmux"]),
    );
    expect(Surface.safeParse("github").success).toBe(true);
    expect(Surface.safeParse("not-a-surface").success).toBe(false);
  });
});

describe("VerbEffects — Rule 4 (one write surface per verb)", () => {
  test("a pure read parses with no writes (defaults)", () => {
    const e = VerbEffects.parse({ reads: ["github", "cas"] });
    expect(e.writes).toBeNull();
    expect(isReadOnly(e)).toBe(true);
  });

  test("a single write surface is allowed", () => {
    const e = VerbEffects.parse({ reads: ["cas"], writes: "github" });
    expect(e.writes).toBe("github");
    expect(isReadOnly(e)).toBe(false);
  });

  test("two write surfaces are structurally unrepresentable (schema rejects an array)", () => {
    expect(VerbEffects.safeParse({ writes: ["github", "beads"] }).success).toBe(false);
  });

  test("an unknown surface is rejected in reads or writes", () => {
    expect(VerbEffects.safeParse({ reads: ["nope"] }).success).toBe(false);
    expect(VerbEffects.safeParse({ writes: "nope" }).success).toBe(false);
  });

  test("touchedSurfaces unions reads + the single write, de-duplicated", () => {
    expect(touchedSurfaces(VerbEffects.parse({ reads: ["cas", "github"], writes: "github" })).sort())
      .toEqual(["cas", "github"]);
    expect(touchedSurfaces(VerbEffects.parse({ reads: ["beads"] }))).toEqual(["beads"]);
  });
});

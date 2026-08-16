// prx-g88.4 — the layered intake ⊗ actor salt. Verifies determinism, the two
// layers (intake-bound + actor-scoped), no-sharing between actors, and the
// derived worktree/branch names.

import { describe, expect, test } from "bun:test";
import {
  SALT_LENGTH,
  actorBranchName,
  actorSalt,
  actorSaltForSource,
  actorWorktreeDirName,
  unitSalt,
} from "../../src/provenance/actor-salt.ts";

const SRC_A = "sha256:" + "a".repeat(64);
const SRC_B = "sha256:" + "b".repeat(64);

describe("unitSalt (prx-g88.4)", () => {
  test("deterministic, short hex, domain-separated", () => {
    const s = unitSalt(SRC_A);
    expect(s).toBe(unitSalt(SRC_A));
    expect(s).toMatch(/^[0-9a-f]+$/);
    expect(s.length).toBe(SALT_LENGTH);
  });

  test("different source digests → different unit salts", () => {
    expect(unitSalt(SRC_A)).not.toBe(unitSalt(SRC_B));
  });

  test("an empty source digest throws (must be minted at intake)", () => {
    expect(() => unitSalt("")).toThrow(/non-empty/);
  });
});

describe("actorSalt (prx-g88.4)", () => {
  test("deterministic + recomputable", () => {
    const u = unitSalt(SRC_A);
    expect(actorSalt(u, "keeper")).toBe(actorSalt(u, "keeper"));
  });

  test("two actors on the SAME unit get DIFFERENT salts (no sharing)", () => {
    const u = unitSalt(SRC_A);
    expect(actorSalt(u, "keeper")).not.toBe(actorSalt(u, "forge"));
  });

  test("the SAME actor on DIFFERENT units gets different salts (bound to intake)", () => {
    expect(actorSalt(unitSalt(SRC_A), "keeper")).not.toBe(actorSalt(unitSalt(SRC_B), "keeper"));
  });

  test("actorSaltForSource composes unitSalt + actorSalt", () => {
    expect(actorSaltForSource(SRC_A, "keeper")).toBe(actorSalt(unitSalt(SRC_A), "keeper"));
  });
});

describe("derived names (prx-g88.4)", () => {
  test("worktree dir and branch embed the actor + salt", () => {
    const salt = actorSaltForSource(SRC_A, "keeper");
    expect(actorWorktreeDirName("keeper", salt)).toBe(`keeper-${salt}`);
    expect(actorBranchName("keeper", "prx-2c4", salt)).toBe(`keeper/prx-2c4-${salt}`);
  });

  test("different actors → different worktree dirs (isolation)", () => {
    const u = unitSalt(SRC_A);
    const k = actorWorktreeDirName("keeper", actorSalt(u, "keeper"));
    const f = actorWorktreeDirName("forge", actorSalt(u, "forge"));
    expect(k).not.toBe(f);
  });
});

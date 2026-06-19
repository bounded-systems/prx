// prx-1dz — the delegation-DAG verification spine: a privileged effect must be
// produced by an owning actor (ambient authority := an orphan effect).

import { describe, expect, test } from "bun:test";
import type { Derivation } from "@bounded-systems/anchored-chain";
import {
  delegationInputKey,
  effectKindOf,
  verifyEffectOwnership,
} from "../../src/provenance/effect-ownership.ts";

/** Minimal effect derivation: a git `subcommand` produced by `prx://<actor>/<verb>`. */
function effectDerivation(actor: string, subcommand: string): Derivation {
  return {
    derivationId: "sha256:" + "0".repeat(64),
    manifest: {
      producer: `prx://${actor}/${subcommand}`,
      inputs: {},
      outputs: { commit: "gitCommit:" + "a".repeat(40) },
      contracts: [],
      params: { subcommand, args: [] },
    },
    ts: 0,
  } as unknown as Derivation;
}

describe("effectKindOf (prx-1dz)", () => {
  test("git effects expose their (tool, subcommand)", () => {
    expect(effectKindOf(effectDerivation("keeper", "push"))).toEqual({
      tool: "git",
      subcommand: "push",
    });
  });

  test("a derivation with no subcommand is not an enforced effect", () => {
    const d = effectDerivation("keeper", "push");
    (d.manifest as { params: Record<string, unknown> }).params = {};
    expect(effectKindOf(d)).toBeNull();
  });
});

describe("verifyEffectOwnership (prx-1dz)", () => {
  test("keeper owns git push → ok", () => {
    const r = verifyEffectOwnership(effectDerivation("keeper", "push"));
    expect(r.ok).toBe(true);
    expect(r.owners).toContain("keeper");
  });

  test("a push produced by reviewer is an orphan/ambient effect → fail closed", () => {
    const r = verifyEffectOwnership(effectDerivation("reviewer", "push"));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("does not own");
    expect(r.reason).toContain("orphan/ambient effect");
  });

  test("a commit produced by forge (gh-only custody) is an orphan effect", () => {
    // forge has no git rows in the policy table, so it owns no git effect.
    const r = verifyEffectOwnership(effectDerivation("forge", "commit"));
    expect(r.ok).toBe(false);
    expect(r.owners ?? []).not.toContain("forge");
  });

  test("a non-effect derivation passes through", () => {
    const d = effectDerivation("keeper", "push");
    (d.manifest as { params: Record<string, unknown> }).params = {};
    expect(verifyEffectOwnership(d).ok).toBe(true);
  });

  test("a producer with an unparseable builder id fails", () => {
    const d = effectDerivation("keeper", "push");
    (d.manifest as { producer: string }).producer = "not-a-prx-builder-id";
    const r = verifyEffectOwnership(d);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no parseable actor");
  });

  test("a non-role producer (session-profile actor) passes through in v1", () => {
    // `work`/`implement` are session-profile actors, not policy-role names — they
    // need the profile→role map (follow-up), so v1 does not fail them.
    const r = verifyEffectOwnership(effectDerivation("work", "commit"));
    expect(r.ok).toBe(true);
    expect(r.actor).toBe("work");
  });
});

describe("delegationInputKey (prx-1dz)", () => {
  test("formats the delegation edge key for a parent derivation's inputs", () => {
    expect(delegationInputKey("keeper", "push")).toBe("delegate:keeper/push");
  });
});

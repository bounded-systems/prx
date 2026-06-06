// prx-1dz (audit surface) — the provenance-ownership .feature must (a) not drift
// from the generator and (b) be FAITHFUL: every ownership row has to match the
// runtime verify gate (`verifyEffectOwnership`), not merely the helper it was
// generated from. The dual of test/agents/capability_feature.test.ts.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POLICY_ROLES,
  POLICY_STATES,
  blockedSubcommands,
  findOwningRoles,
  ownersOf,
  type PolicyRole,
} from "@bounded-systems/policy";
import type { Derivation } from "@bounded-systems/anchored-chain";
import {
  attestedGitWrites,
  generateProvenanceFeature,
} from "../../src/provenance/ownership_feature.ts";
import { verifyEffectOwnership } from "../../src/provenance/effect-ownership.ts";
import { REPO_ROOT } from "../../src/repo-root.ts";

const featurePath = join(REPO_ROOT, "features", "provenance-ownership.feature");

/** A minimal signed git-effect derivation with the given producer + subcommand. */
function gitEffect(producer: string, subcommand: string): Derivation {
  return {
    derivationId: "sha256:" + "0".repeat(64),
    manifest: { producer, inputs: {}, outputs: {}, contracts: [], params: { subcommand } },
    ts: 0,
  } as unknown as Derivation;
}

const builderFor = (actor: string) => `prx://${actor}/effect`;

describe("provenance-ownership .feature (prx-1dz audit surface)", () => {
  test("the committed feature matches the generator (no drift)", () => {
    expect(existsSync(featurePath)).toBe(true);
    expect(
      readFileSync(featurePath, "utf8"),
      "features/provenance-ownership.feature is stale — run `bun packages/prx/scripts/gen-provenance-feature.ts` and commit",
    ).toBe(generateProvenanceFeature());
  });

  test("FAITHFUL: a git write verifies iff the runtime gate sees its producer as an owner", () => {
    for (const sub of attestedGitWrites()) {
      const owners = new Set(ownersOf("git", sub));
      for (const role of POLICY_ROLES) {
        const verdict = verifyEffectOwnership(gitEffect(builderFor(role), sub));
        expect(
          verdict.ok,
          `git ${sub}: owner=${owners.has(role)} but verifyEffectOwnership.ok=${verdict.ok} for ${role}`,
        ).toBe(owners.has(role));
      }
    }
  });

  test("FAITHFUL: a signed effect for a hard-blocked subcommand is rejected for every actor", () => {
    for (const sub of blockedSubcommands("git")) {
      for (const role of POLICY_ROLES) {
        expect(verifyEffectOwnership(gitEffect(builderFor(role), sub)).ok).toBe(false);
      }
    }
  });

  test("FAITHFUL: a non-policy-role producer passes through; a malformed producer is rejected", () => {
    expect(verifyEffectOwnership(gitEffect("prx://work/effect", "push")).ok).toBe(true);
    expect(verifyEffectOwnership(gitEffect("malformed-no-scheme", "push")).ok).toBe(false);
  });

  test("consolidation: ownersOf equals the union-across-states owner map it replaced", () => {
    // Guards the refactor that pointed both the guard feature and this verify
    // gate at a single `ownersOf` — it must equal the old per-state union.
    const legacyUnion = (sub: string): PolicyRole[] => {
      const acc = new Set<PolicyRole>();
      for (const state of POLICY_STATES) {
        for (const role of findOwningRoles("git", sub, state)) acc.add(role);
      }
      return [...acc];
    };
    for (const sub of attestedGitWrites()) {
      expect([...ownersOf("git", sub)].sort()).toEqual([...legacyUnion(sub)].sort());
    }
  });
});

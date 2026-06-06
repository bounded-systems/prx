// prx-g88.7 (7a) — the capability-ownership .feature must (a) not drift from the
// generator and (b) be FAITHFUL: every ownership claim has to match the
// enforcement predicate (isFeasibleForRole) and the runtime guard, not merely
// the helper it was generated from.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POLICY_ROLES,
  POLICY_STATES,
  POLICY_TOOLS,
  blockedSubcommands,
  isFeasibleForRole,
} from "@bounded-systems/policy";
import {
  auditedWrites,
  generateCapabilityFeature,
  ownersOf,
} from "../../src/agents/capability_feature.ts";
import { decideAgentToolCall } from "../../src/agents/policy_guard.ts";
import { findRepoRoot } from "../../src/repo-root.ts";
const REPO_ROOT = findRepoRoot();

const featurePath = join(REPO_ROOT, "features", "capability-ownership.feature");

describe("capability-ownership .feature (prx-g88.7 / 7a)", () => {
  test("the committed feature matches the generator (no drift)", () => {
    expect(existsSync(featurePath)).toBe(true);
    expect(
      readFileSync(featurePath, "utf8"),
      "features/capability-ownership.feature is stale — run `bun packages/prx/scripts/gen-capability-feature.ts` and commit",
    ).toBe(generateCapabilityFeature());
  });

  test("FAITHFUL: a role owns a write iff the enforcement predicate allows it in some state", () => {
    for (const tool of POLICY_TOOLS) {
      for (const sub of auditedWrites(tool)) {
        const owners = new Set(ownersOf(tool, sub));
        for (const role of POLICY_ROLES) {
          const feasibleSomewhere = POLICY_STATES.some(
            (state) => isFeasibleForRole(tool, sub, state, role).feasible,
          );
          expect(
            owners.has(role),
            `${tool} ${sub}: owners says ${owners.has(role)} but isFeasibleForRole says ${feasibleSomewhere} for ${role}`,
          ).toBe(feasibleSomewhere);
        }
      }
    }
  });

  test("custody boundaries: keeper owns the object-graph writers; forge owns merge/ready", () => {
    expect(ownersOf("git", "commit-tree")).toEqual(["keeper"]);
    expect(ownersOf("git", "write-tree")).toEqual(["keeper"]);
    expect(ownersOf("gh", "merge")).toEqual(["forge"]);
    expect(ownersOf("gh", "ready")).toEqual(["forge"]);
  });

  test("every hard-blocked subcommand is listed and owned by no one", () => {
    const feature = generateCapabilityFeature();
    for (const tool of POLICY_TOOLS) {
      for (const sub of blockedSubcommands(tool)) {
        expect(feature).toContain(`| ${tool}`);
        expect(feature).toContain(sub);
        // A blocked subcommand never appears as an audited write owner.
        expect(auditedWrites(tool).includes(sub)).toBe(false);
      }
    }
  });

  test("the orchestrator scenario reflects the runtime guard (denied)", () => {
    expect(generateCapabilityFeature()).toContain("the orchestrator cannot run a privileged tool");
    expect(decideAgentToolCall({ agentType: "orchestrator", command: "git push" }).allow).toBe(false);
  });
});

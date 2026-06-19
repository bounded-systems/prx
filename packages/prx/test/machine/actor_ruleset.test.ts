// GH-1530 — registry-derived per-actor permission helper. Proves the
// object-capability properties of `actorRuleset` in isolation (the profile
// composition that layers transitional `extraAllow` lives in
// test/pr-state/runtime_profiles.test.ts).

import { describe, expect, test } from "bun:test";

import {
  actorRuleset,
  BASE_TOOLS_BY_ROLE,
  SHARED_DENY,
  type RulesetRole,
} from "../../src/machine/actor_ruleset.ts";
import type { ActorName } from "../../src/machine/actor_names.ts";

// The six session-profile owning actors (the consumers in runtime_profiles).
const OWNING_ACTORS = [
  "plan",
  "intake",
  "triage",
  "implement",
  "submit",
  "author",
] as const satisfies readonly ActorName[];

describe("actorRuleset — own-namespace grant (AC1)", () => {
  test("each ruleset grants exactly its own `Bash(prx <actor>:*)` namespace", () => {
    for (const actor of OWNING_ACTORS) {
      const { allowedTools } = actorRuleset(actor);
      expect(allowedTools).toContain(`Bash(prx ${actor}:*)`);
    }
  });

  test("a base ruleset (no extraAllow) contains NO foreign `Bash(prx X:*)` grant", () => {
    for (const actor of OWNING_ACTORS) {
      const { allowedTools } = actorRuleset(actor);
      const foreignPrx = allowedTools.filter(
        (t) => t.startsWith("Bash(prx ") && t !== `Bash(prx ${actor}:*)`,
      );
      expect(
        foreignPrx,
        `'${actor}' base ruleset leaked foreign prx grants: ${foreignPrx.join(", ")}`,
      ).toEqual([]);
    }
  });

  test("omitOwnNamespace drops the glob (the `submit` posture)", () => {
    const { allowedTools } = actorRuleset("submit", { omitOwnNamespace: true });
    expect(allowedTools).not.toContain("Bash(prx submit:*)");
    expect(allowedTools.some((t) => t.startsWith("Bash(prx "))).toBe(false);
  });
});

describe("actorRuleset — shared deny (AC1)", () => {
  test("every ruleset denies raw gh/bd/git", () => {
    for (const actor of OWNING_ACTORS) {
      const { disallowedTools } = actorRuleset(actor);
      expect(disallowedTools).toContain("Bash(gh:*)");
      expect(disallowedTools).toContain("Bash(bd:*)");
      expect(disallowedTools).toContain("Bash(git:*)");
    }
  });

  test("every ruleset inherits the full SHARED_DENY set", () => {
    for (const actor of OWNING_ACTORS) {
      const { disallowedTools } = actorRuleset(actor);
      for (const shared of SHARED_DENY) {
        expect(disallowedTools).toContain(shared);
      }
    }
  });

  test("reader denies Edit/Write by default; executor allows them", () => {
    const reader = actorRuleset("plan", { role: "reader" });
    expect(reader.disallowedTools).toContain("Edit");
    expect(reader.disallowedTools).toContain("Write");
    expect(reader.allowedTools).not.toContain("Edit");

    const executor = actorRuleset("implement", { role: "executor" });
    expect(executor.allowedTools).toContain("Edit");
    expect(executor.allowedTools).toContain("Write");
    expect(executor.disallowedTools).not.toContain("Edit");
    expect(executor.disallowedTools).not.toContain("Write");
  });

  test("denyWrite:false omits the Write deny (the `plan` staging carve-out)", () => {
    const plan = actorRuleset("plan", { role: "reader", denyWrite: false });
    expect(plan.disallowedTools).toContain("Edit");
    expect(plan.disallowedTools).not.toContain("Write");
  });
});

describe("actorRuleset — uniqueness across owning actors (AC2)", () => {
  test("the six owning actors produce six distinct rulesets", () => {
    const fingerprints = OWNING_ACTORS.map((a) => JSON.stringify(actorRuleset(a)));
    expect(new Set(fingerprints).size).toBe(OWNING_ACTORS.length);
  });

  test("each ruleset's own-namespace glob is unique to that actor", () => {
    const globs = OWNING_ACTORS.map((a) => `Bash(prx ${a}:*)`);
    for (const actor of OWNING_ACTORS) {
      const { allowedTools } = actorRuleset(actor);
      const mine = `Bash(prx ${actor}:*)`;
      const foreign = globs.filter((g) => g !== mine);
      expect(allowedTools).toContain(mine);
      for (const g of foreign) expect(allowedTools).not.toContain(g);
    }
  });
});

describe("actorRuleset — registry-vocabulary invariance (AC4)", () => {
  test("base allow = role base + own glob (independent of any verb count)", () => {
    // The own-namespace grant is a glob over the actor's CLI namespace, so
    // adding a `CommandSpec` under an actor never changes its ruleset — the
    // verb becomes runnable via the existing glob with zero edits here.
    for (const role of ["reader", "executor"] as const satisfies readonly RulesetRole[]) {
      const { allowedTools } = actorRuleset("plan", { role });
      expect(allowedTools).toEqual([...BASE_TOOLS_BY_ROLE[role], "Bash(prx plan:*)"]);
    }
  });

  test("extraAllow/extraDeny are appended and de-duplicated", () => {
    const { allowedTools, disallowedTools } = actorRuleset("plan", {
      role: "reader",
      extraAllow: ["Bash(prx model:*)", "Bash(prx model:*)"],
      extraDeny: ["Bash(gh:*)", "Bash(prx submit publish:*)"],
    });
    expect(allowedTools.filter((t) => t === "Bash(prx model:*)")).toHaveLength(1);
    // SHARED_DENY already carries gh:*; extraDeny must not duplicate it.
    expect(disallowedTools.filter((t) => t === "Bash(gh:*)")).toHaveLength(1);
    expect(disallowedTools).toContain("Bash(prx submit publish:*)");
  });
});

describe("actorRuleset — fails loud on a non-canonical actor", () => {
  test("throws for an unknown actor name", () => {
    expect(() => actorRuleset("ghost" as ActorName)).toThrow(/not a canonical actor/);
  });
});

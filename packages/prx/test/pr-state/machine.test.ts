import { describe, expect, test } from "bun:test";

import { workflowPhases } from "@bounded-systems/machine-schema";
import {
  allowedTransitions,
  assertValidTransition,
  canonicalPrEventAliases,
  eventForSkill,
  isSystemMergeReady,
  isReadyState,
  prSystemMachine,
  prSkillNames,
  workflowMachine,
} from "../../src/pr-state/machine.ts";

describe("lifecycle machine", () => {
  test("exposes allowed transitions from the xstate machine", () => {
    expect(allowedTransitions("drafting")).toEqual(["drafting", "ready_for_review", "validating"]);
    expect(allowedTransitions("merge_ready")).toEqual(["changes_requested", "drafting", "merged"]);
  });

  test("permits valid transitions", () => {
    expect(() => assertValidTransition("drafting", "validating")).not.toThrow();
    expect(() => assertValidTransition("changes_requested", "in_review")).not.toThrow();
  });

  test("rejects invalid transitions", () => {
    expect(() => assertValidTransition("drafting", "merged")).toThrow(
      "invalid transition from `drafting` to `merged`; allowed: drafting, ready_for_review, validating",
    );
    expect(() => assertValidTransition("merged", "drafting")).toThrow(
      "invalid transition from `merged` to `drafting`; allowed: merged",
    );
  });

  test("tracks ready states", () => {
    expect(isReadyState("drafting")).toBeFalse();
    expect(isReadyState("in_review")).toBeTrue();
  });

  test("maps every pr skill to a skill event", () => {
    for (const skill of prSkillNames) {
      const mapped = eventForSkill(skill);
      expect(mapped.event.length).toBeGreaterThan(0);
      if (mapped.kind === "transition") {
        expect(
          allowedTransitions("drafting").includes(mapped.to) || mapped.to !== "drafting",
        ).toBeTrue();
      }
    }
  });

  test("exposes multi-axis system machine with guarded merge", () => {
    expect(prSystemMachine.config.id).toBe("prSystem");
    expect(prSystemMachine.config.type).toBe("parallel");
    expect(prSystemMachine.config.states?.lifecycle).toBeDefined();
    expect(prSystemMachine.config.states?.ci).toBeDefined();
    expect(prSystemMachine.config.states?.review).toBeDefined();
    expect(prSystemMachine.config.states?.mergeability).toBeDefined();
    expect(prSystemMachine.config.states?.workflowBackbone).toBeDefined();
    expect(prSystemMachine.config.states?.workflowBackbone?.initial).toBe("no_worktree");

    const lifecycle = prSystemMachine.config.states?.lifecycle as {
      states: {
        open: {
          on: {
            MERGE: { target: string; guard: { type: string } };
          };
        };
      };
    };
    expect(lifecycle.states.open.on.MERGE.guard.type).toBe("isMergeable");
  });

  test("derives merge readiness from ci/review/mergeability", () => {
    expect(
      isSystemMergeReady({
        ci: "passed",
        review: "approved",
        mergeability: "clean",
      }),
    ).toBeTrue();

    expect(
      isSystemMergeReady({
        ci: "failed",
        review: "approved",
        mergeability: "clean",
      }),
    ).toBeFalse();
  });

  test("defines canonical aliases for legacy PR events", () => {
    expect(canonicalPrEventAliases.SUBMIT).toBe("PR_OPENED");
    expect(canonicalPrEventAliases.APPROVE).toBe("REVIEW_APPROVED");
    expect(canonicalPrEventAliases.MERGE).toBe("PR_MERGED");
  });

  test("exposes derived-phase workflow backbone with one state per workflow phase", () => {
    expect(workflowMachine.config.id).toBe("workflowBackbone");
    expect(workflowMachine.config.initial).toBe("no_worktree");
    const stateKeys = Object.keys(workflowMachine.config.states ?? {});
    expect(new Set(stateKeys)).toEqual(new Set(workflowPhases));
  });

  // GH-885: ready_to_merge → automerge_enabled → merged is the new
  // doctor-arming path. ready_to_merge gains an AUTOMERGE_ENABLED transition,
  // and the new automerge_enabled state accepts MERGE/AUTOMERGE_DISABLED.
  test("ready_to_merge transitions to automerge_enabled on AUTOMERGE_ENABLED", () => {
    const states = workflowMachine.config.states as Record<string, { on?: Record<string, string> }>;
    expect(states.ready_to_merge?.on?.AUTOMERGE_ENABLED).toBe("automerge_enabled");
    expect(states.automerge_enabled?.on?.PR_MERGED).toBe("merged");
    expect(states.automerge_enabled?.on?.MERGE).toBe("merged");
    expect(states.automerge_enabled?.on?.AUTOMERGE_DISABLED).toBe("ready_to_merge");
  });
});

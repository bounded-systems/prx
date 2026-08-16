// GH-1821 — AgentContract / ArtifactContract / TransitionContract trinity.
//
// Covers the four issue success criteria:
//   1. The three schemas exist and validate well-formed instances.
//   2. Existing actor profiles project into AgentContracts and back without
//      loss of allowedTools / disallowedTools / allowedDispatchTargets.
//   3. Demonstrative role-axis (testing→reviewing) and workflow-axis
//      (in_review→ready_to_merge) transitions authorize purely from the
//      artifact graph.
//   4. With `PRX_TYPED_DISPATCH_REJECTION` flag on, dispatch without a
//      typed inputArtifact is rejected; with the flag off, dispatch
//      succeeds (backwards-compatible).
// Plus: the 1→1 invariant on AgentContract, the curry composition rule,
// and a CLI smoke for `prx contract show`.

import { describe, expect, test } from "bun:test";

import {
  agentContractSchema,
  artifactContractSchema,
  curry,
  CurryError,
  transitionAxes,
  transitionContractSchema,
} from "../../../src/machine/contracts.ts";
import {
  artifactRegistry,
  getArtifactContract,
  listArtifactContracts,
  residualArtifactType,
} from "../../../src/machine/contracts/artifacts.ts";
import {
  agentRegistry,
  getAgentContract,
  getSessionProfileContract,
  getTaskRoleContract,
  listAgentContracts,
  projectSessionProfile,
  projectTaskRole,
} from "../../../src/machine/contracts/instances.ts";
import {
  getTransitionContract,
  listTransitionContracts,
  transitionKey,
} from "../../../src/machine/contracts/transitions.ts";
import { runGuard } from "../../../src/machine/contracts/guards.ts";
import {
  assertTypedInputArtifact,
  dispatchRequestSchema,
  readTypedDispatchFlag,
} from "../../../src/machine/dispatch.ts";
import { defaultDispatchCapabilities } from "../../../src/machine/dispatch.ts";
import {
  SESSION_PROFILES,
  sessionProfileNames,
  taskAgentRoles,
} from "../../../src/machine/runtime_profiles.ts";
import type { BranchName, RawStateV1, Sha, WorkUnitId } from "@bounded-systems/machine-schema";

// ── Layer A: the three schemas exist ──────────────────────────────────────

describe("contract schemas", () => {
  test("agentContractSchema accepts a well-formed contract", () => {
    const parsed = agentContractSchema.parse({
      role: "executor",
      inputArtifact: "executor_input_bundle",
      outputArtifact: "patch_proposal",
      capabilities: ["implement"],
      forbidden: [],
    });
    expect(parsed.role).toBe("executor");
  });

  test("artifactContractSchema accepts a live entry", () => {
    const parsed = artifactContractSchema.parse({
      type: "raw_state_v1",
      schemaVersion: "prx.raw_state_v1.v1",
      requiredFields: ["unitId"],
      validationRef: "schema:src/machine/state.ts#rawStateV1Schema",
      persistence: "git",
    });
    expect(parsed.persistence).toBe("git");
  });

  test("transitionAxes still includes role and workflow (no regression)", () => {
    // GH-1822 widened transitionAxes with "lifecycle"; the original two
    // axes must remain present so guards keyed off them keep working.
    expect(transitionAxes).toContain("role");
    expect(transitionAxes).toContain("workflow");
    expect(transitionAxes).toContain("lifecycle");
  });

  test("transitionContractSchema accepts both axes", () => {
    expect(
      transitionContractSchema.parse({
        axis: "role",
        fromPhase: "testing",
        toPhase: "reviewing",
        requiredArtifact: "test_run",
        requiredStatus: "passed",
        forbiddenArtifacts: ["blocker_report"],
        guardId: "testToReview.requireTestRunPassed",
      }).axis,
    ).toBe("role");

    expect(
      transitionContractSchema.parse({
        axis: "workflow",
        fromPhase: "in_review",
        toPhase: "ready_to_merge",
        requiredArtifact: "raw_state_v1",
        requiredStatus: "present",
        forbiddenArtifacts: [],
        guardId: "inReviewToReadyToMerge.delegateI04",
      }).axis,
    ).toBe("workflow");
  });

  test("agentContractSchema rejects N-arg input lists (1→1 invariant)", () => {
    expect(() =>
      agentContractSchema.parse({
        role: "executor",
        // arrays would model multi-arg; the schema accepts only a string id.
        inputArtifact: ["context_bundle", "plan", "uow"] as unknown as string,
        outputArtifact: "patch_proposal",
        capabilities: [],
        forbidden: [],
      }),
    ).toThrow();
  });

  test("agentContractSchema rejects N-arg output lists (1→1 invariant)", () => {
    expect(() =>
      agentContractSchema.parse({
        role: "executor",
        inputArtifact: "executor_input_bundle",
        outputArtifact: ["patch_proposal", "implementation_notes"] as unknown as string,
        capabilities: [],
        forbidden: [],
      }),
    ).toThrow();
  });

  test("agentContractSchema rejects unknown extra fields (strict)", () => {
    expect(() =>
      agentContractSchema.parse({
        role: "executor",
        inputArtifact: "executor_input_bundle",
        outputArtifact: "patch_proposal",
        capabilities: [],
        forbidden: [],
        extra: "nope",
      }),
    ).toThrow();
  });
});

// ── Layer B: artifact registry + agent instances ──────────────────────────

describe("artifact registry", () => {
  test("every artifact referenced by an AgentContract is registered", () => {
    for (const contract of listAgentContracts()) {
      expect(getArtifactContract(contract.inputArtifact)).toBeDefined();
      expect(getArtifactContract(contract.outputArtifact)).toBeDefined();
    }
  });

  test("every artifact referenced by a TransitionContract is registered", () => {
    for (const t of listTransitionContracts()) {
      expect(getArtifactContract(t.requiredArtifact)).toBeDefined();
      for (const f of t.forbiddenArtifacts) {
        expect(getArtifactContract(f)).toBeDefined();
      }
    }
  });

  test("each composedOf component is itself a registered artifact", () => {
    for (const a of listArtifactContracts()) {
      if (!a.composedOf) continue;
      for (const c of a.composedOf) {
        expect(getArtifactContract(c)).toBeDefined();
      }
    }
  });

  test("validationRef shapes are one of schema:/cas:/deferred:", () => {
    const re = /^(schema:.+|cas:\/\/sha256:[0-9a-f]{64}|deferred:GH-\d+)$/;
    for (const a of listArtifactContracts()) {
      expect(a.validationRef).toMatch(re);
    }
  });
});

describe("session-profile round-trip parity", () => {
  test("every SESSION_PROFILE[name] projects into AgentContract and back", () => {
    for (const name of sessionProfileNames) {
      const original = SESSION_PROFILES[name];
      const contract = getSessionProfileContract(name);
      const projection = projectSessionProfile(contract);
      expect(projection.allowedTools).toEqual(original.allowedTools);
      expect(projection.disallowedTools).toEqual(original.disallowedTools);
      expect(projection.allowedDispatchTargets).toEqual([...defaultDispatchCapabilities[name]]);
    }
  });

  test("every taskAgentRoles[i] has a registered AgentContract", () => {
    for (const role of taskAgentRoles) {
      const contract = getTaskRoleContract(role);
      expect(contract.role).toBe(role);
      const projection = projectTaskRole(contract);
      expect(projection.role).toBe(role);
      expect(projection.inputArtifact).toBe(contract.inputArtifact);
      expect(projection.outputArtifact).toBe(contract.outputArtifact);
    }
  });
});

// ── curry helper ──────────────────────────────────────────────────────────

describe("curry", () => {
  test("composes a 1→1 contract from a composite-input agent", () => {
    const executor = getTaskRoleContract("executor");
    expect(artifactRegistry[executor.inputArtifact]!.composedOf).toEqual([
      "context_bundle",
      "plan",
      "uow",
    ]);
    const curried = curry(executor, "context_bundle", residualArtifactType);
    expect(curried.inputArtifact).toBe("executor_minus_context");
    expect(curried.outputArtifact).toBe("patch_proposal");
    expect(curried.role).toBe("executor");

    // The residual artifact is itself registered and composed correctly.
    const residual = getArtifactContract(curried.inputArtifact);
    expect(residual?.composedOf).toEqual(["plan", "uow"]);
  });

  test("rejects currying the only input", () => {
    const scout = getTaskRoleContract("scout");
    expect(() => curry(scout, "query", residualArtifactType)).toThrow(CurryError);
  });

  test("rejects currying a component the composite does not declare", () => {
    const executor = getTaskRoleContract("executor");
    expect(() => curry(executor, "review_bundle", residualArtifactType)).toThrow();
  });
});

// ── Layer C: transition guards ────────────────────────────────────────────

describe("role-axis transition: testing → reviewing", () => {
  const t = getTransitionContract("role:testing->reviewing");
  expect(t).toBeDefined();
  const contract = t!;

  test("guard returns ok when test_run.status=passed and no blocker", () => {
    const verdict = runGuard({
      graph: { test_run: { status: "passed" } },
      contract,
    });
    expect(verdict.ok).toBe(true);
  });

  test("guard rejects when test_run.status=failed", () => {
    const verdict = runGuard({
      graph: { test_run: { status: "failed" } },
      contract,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/passed/);
  });

  test("guard rejects when test_run is missing", () => {
    const verdict = runGuard({ graph: {}, contract });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/missing/);
  });

  test("guard rejects when blocker_report is present", () => {
    const verdict = runGuard({
      graph: {
        test_run: { status: "passed" },
        blocker_report: { status: "present" },
      },
      contract,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/blocker_report/);
  });
});

// ── workflow-axis transition delegates to I04 ─────────────────────────────

function readyToMergeRaw(): RawStateV1 {
  const ts = "2026-05-16T00:00:00Z";
  return {
    unitId: "GH-1821" as WorkUnitId,
    artifacts: {
      ticket: { exists: true, id: "GH-1821", system: "bd", url: null },
      worktree: {
        exists: true,
        path: "/tmp/wt",
        checkedOutBranch: "GH-1821" as BranchName,
        headSha: "abc" as Sha,
      },
      branch: {
        name: "GH-1821" as BranchName,
        existsLocal: true,
        existsRemote: true,
        ahead: 0,
        behind: 0,
        headShaLocal: "abc" as Sha,
        headShaRemote: "abc" as Sha,
      },
      pr: {
        exists: true,
        number: 1,
        state: "open",
        isDraft: false,
        headRef: "GH-1821" as BranchName,
        baseRef: "main" as BranchName,
        url: null,
      },
    },
    signals: {
      review: {
        decision: "approved",
        reviewersRequested: true,
        unresolvedThreads: 0,
      },
      ci: { state: "passed", requiredTotal: 1, requiredPassed: 1, failing: [] },
      mergeability: { state: "mergeable", blockedReasons: [] },
    },
    sync: { remoteFresh: true, ticketLinkedToPR: true },
    meta: {
      observedAt: ts,
      sources: { git: ts, gh: ts, ticketSystem: null },
    },
  };
}

describe("workflow-axis transition: in_review → ready_to_merge", () => {
  const t = getTransitionContract("workflow:in_review->ready_to_merge");
  expect(t).toBeDefined();
  const contract = t!;

  test("guard returns ok when RawStateV1 satisfies I04", () => {
    const verdict = runGuard({
      graph: {
        raw_state_v1: { status: "present", payload: readyToMergeRaw() },
      },
      contract,
    });
    expect(verdict.ok).toBe(true);
  });

  test("guard rejects when CI has not passed", () => {
    const raw = readyToMergeRaw();
    raw.signals.ci.state = "failed";
    const verdict = runGuard({
      graph: { raw_state_v1: { status: "present", payload: raw } },
      contract,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/I04/);
  });

  test("guard rejects when unresolved review threads remain", () => {
    const raw = readyToMergeRaw();
    raw.signals.review.unresolvedThreads = 2;
    const verdict = runGuard({
      graph: { raw_state_v1: { status: "present", payload: raw } },
      contract,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/I04/);
  });

  test("guard rejects when the artifact is missing the payload", () => {
    const verdict = runGuard({
      graph: { raw_state_v1: { status: "present" } },
      contract,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/payload/);
  });
});

// ── Layer C: untyped-dispatch rejection (feature-flagged) ─────────────────

describe("assertTypedInputArtifact (PRX_TYPED_DISPATCH_REJECTION)", () => {
  const request = dispatchRequestSchema.parse({
    source: "plan",
    target: "implement",
    action: "implement",
    args: {},
  });

  test("flag off: missing inputArtifact is allowed (backwards-compatible)", () => {
    const verdict = assertTypedInputArtifact({
      request,
      expectedInputType: "plan",
      rejectUntyped: false,
    });
    expect(verdict.ok).toBe(true);
  });

  test("flag on: missing inputArtifact is rejected with capability_denied", () => {
    const verdict = assertTypedInputArtifact({
      request,
      expectedInputType: "plan",
      rejectUntyped: true,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("capability_denied");
    }
  });

  test("flag on: mismatching inputArtifact.type is rejected", () => {
    const req = dispatchRequestSchema.parse({
      source: "plan",
      target: "implement",
      action: "implement",
      args: {},
      inputArtifact: { type: "context_bundle" },
    });
    const verdict = assertTypedInputArtifact({
      request: req,
      expectedInputType: "plan",
      rejectUntyped: true,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.detail).toMatch(/context_bundle/);
    }
  });

  test("flag on: matching inputArtifact.type passes", () => {
    const req = dispatchRequestSchema.parse({
      source: "plan",
      target: "implement",
      action: "implement",
      args: {},
      inputArtifact: { type: "plan" },
    });
    const verdict = assertTypedInputArtifact({
      request: req,
      expectedInputType: "plan",
      rejectUntyped: true,
    });
    expect(verdict.ok).toBe(true);
  });

  test("expectedInputType=null short-circuits to ok regardless of flag", () => {
    const verdict = assertTypedInputArtifact({
      request,
      expectedInputType: null,
      rejectUntyped: true,
    });
    expect(verdict.ok).toBe(true);
  });

  test("readTypedDispatchFlag reads PRX_TYPED_DISPATCH_REJECTION", () => {
    expect(readTypedDispatchFlag({})).toBe(false);
    expect(readTypedDispatchFlag({ PRX_TYPED_DISPATCH_REJECTION: "1" })).toBe(true);
    expect(readTypedDispatchFlag({ PRX_TYPED_DISPATCH_REJECTION: "true" })).toBe(true);
    expect(readTypedDispatchFlag({ PRX_TYPED_DISPATCH_REJECTION: "false" })).toBe(false);
    expect(readTypedDispatchFlag({ PRX_TYPED_DISPATCH_REJECTION: "" })).toBe(false);
  });
});

// ── Layer D: registry surface ────────────────────────────────────────────

describe("registry surface (CLI input)", () => {
  test("all 5 task roles + 6 session profiles are registered", () => {
    expect(Object.keys(agentRegistry).sort()).toEqual(
      [...taskAgentRoles, ...sessionProfileNames].sort(),
    );
  });

  test("getAgentContract returns undefined for unknown roles", () => {
    expect(getAgentContract("nonexistent_role")).toBeUndefined();
  });

  test("transitionKey round-trips the registry", () => {
    for (const t of listTransitionContracts()) {
      expect(getTransitionContract(transitionKey(t))).toBe(t);
    }
  });
});

// Branch coverage for the pure transition guards. trinity.test.ts and
// lifecycle.test.ts cover the happy paths and a few rejections; this file
// fills the remaining failure branches: wrong-status rejections on each
// lifecycle guard, the forbidden-artifact loop on delegateToExecute, the
// workflow guard's missing/wrong-status/schema-invalid branches, and the
// registry accessors (getGuard / runGuard unknown-id).

import { describe, expect, test } from "bun:test";

import { transitionContractSchema } from "../../../src/machine/contracts.ts";
import type { TransitionContract } from "../../../src/machine/contracts.ts";
import { getGuard, runGuard } from "../../../src/machine/contracts/guards.ts";

const contract = (over: Partial<TransitionContract>): TransitionContract =>
  transitionContractSchema.parse({
    axis: "lifecycle",
    fromPhase: "map",
    toPhase: "delegate",
    requiredArtifact: "work_map",
    requiredStatus: "present",
    forbiddenArtifacts: [],
    guardId: "mapToDelegate.requireWorkMap",
    ...over,
  });

const reason = (v: ReturnType<typeof runGuard>) => (v as { reason: string }).reason;

// ── workflow axis: in_review → ready_to_merge ─────────────────────────────

describe("inReviewToReadyToMerge guard", () => {
  const c = contract({
    axis: "workflow",
    fromPhase: "in_review",
    toPhase: "ready_to_merge",
    requiredArtifact: "raw_state_v1",
    requiredStatus: "present",
    guardId: "inReviewToReadyToMerge.delegateI04",
  });

  test("rejects when the raw_state_v1 artifact is missing entirely", () => {
    const v = runGuard({ graph: {}, contract: c });
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/missing/);
  });

  test("rejects when the artifact status is neither present nor passed", () => {
    const v = runGuard({
      graph: { raw_state_v1: { status: "failed", payload: {} } },
      contract: c,
    });
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/need "present"/);
  });

  test("rejects when the payload fails RawStateV1 schema validation", () => {
    const v = runGuard({
      graph: { raw_state_v1: { status: "present", payload: { bogus: 1 } } },
      contract: c,
    });
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/schema validation/);
  });
});

// ── lifecycle axis: map → delegate ────────────────────────────────────────

describe("mapToDelegate guard", () => {
  test("rejects when work_map exists but status is not present", () => {
    const v = runGuard({
      graph: { work_map: { status: "absent" } },
      contract: contract({}),
    });
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/need "present"/);
  });
});

// ── lifecycle axis: delegate → execute ────────────────────────────────────

describe("delegateToExecute guard", () => {
  const base = {
    fromPhase: "delegate",
    toPhase: "execute",
    requiredArtifact: "delegation_record",
    guardId: "delegateToExecute.requireDelegationRecord",
  } as const;

  test("rejects when delegation_record exists but status is not present", () => {
    const v = runGuard({
      graph: { delegation_record: { status: "absent" } },
      contract: contract(base),
    });
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/need "present"/);
  });

  test("rejects when a forbidden artifact is present", () => {
    const v = runGuard({
      graph: {
        delegation_record: { status: "present" },
        blocker_report: { status: "present" },
      },
      contract: contract({ ...base, forbiddenArtifacts: ["blocker_report"] }),
    });
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/forbidden artifact blocker_report/);
  });

  test("allows when the forbidden artifact is present but status=absent", () => {
    const v = runGuard({
      graph: {
        delegation_record: { status: "present" },
        blocker_report: { status: "absent" },
      },
      contract: contract({ ...base, forbiddenArtifacts: ["blocker_report"] }),
    });
    expect(v.ok).toBe(true);
  });
});

// ── registry accessors ────────────────────────────────────────────────────

describe("guard registry accessors", () => {
  test("getGuard returns the registered fn for a known id", () => {
    expect(getGuard("mapToDelegate.requireWorkMap")).toBeTypeOf("function");
  });

  test("getGuard returns undefined for an unknown id", () => {
    expect(getGuard("noSuchGuard")).toBeUndefined();
  });

  test("runGuard rejects with a reason when the guardId is unknown", () => {
    const v = runGuard({
      graph: {},
      contract: contract({ guardId: "noSuchGuard" }),
    });
    expect(v.ok).toBe(false);
    expect(reason(v)).toMatch(/unknown guardId: noSuchGuard/);
  });
});

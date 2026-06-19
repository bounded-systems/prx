// GH-1823 — predicate-level tests for I-AUD1..I-AUD5.
//
// Each predicate is exercised on a minimal positive fixture (no findings)
// and a minimal negative fixture (one finding with the right id and a
// non-empty message). The architectural acceptance tests in
// `architecture.test.ts` exercise the same predicates end-to-end through
// the ingester; this file pins the predicates' direct contract.

import { describe, expect, it } from "bun:test";

import type { ArtifactSlot } from "../../src/audit/artifact-types.ts";
import { requiredArtifactTypesForPhase } from "../../src/audit/artifact-types.ts";
import {
  type AuditEvent,
  type DerivedUowStatus,
  type GuardedTransition,
  assertArtifactLineage,
  assertDerivedStatus,
  assertGuardedTransition,
  assertNoAmbientGit,
  assertUowAttachment,
} from "../../src/audit/invariants.ts";

const TS = "2026-05-16T12:00:00.000Z";

function slot(overrides: Partial<ArtifactSlot> & Pick<ArtifactSlot, "type">): ArtifactSlot {
  return {
    type: overrides.type,
    status: overrides.status ?? "present",
    ref: overrides.ref ?? "scout://sha256:fake",
    uow_id: overrides.uow_id ?? "GH-1823",
    input_refs: overrides.input_refs ?? ["scout://sha256:input"],
    last_seen_ts: overrides.last_seen_ts ?? TS,
  };
}

function ev(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    ts: overrides.ts ?? TS,
    uow_id: "uow_id" in overrides ? overrides.uow_id! : "GH-1823",
    actor: overrides.actor ?? "prx",
    action: overrides.action ?? "audit ingest",
    artifact_type: overrides.artifact_type ?? null,
  };
}

describe("I-AUD1 assertUowAttachment", () => {
  it("passes when every event has a uow_id", () => {
    const findings = assertUowAttachment([ev({}), ev({ uow_id: "GH-9" })]);
    expect(findings).toEqual([]);
  });

  it("flags events with uow_id=null", () => {
    const findings = assertUowAttachment([ev({}), ev({ uow_id: null, actor: "claude-code" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("I-AUD1");
    expect(findings[0]!.severity).toBe("hard");
    expect(findings[0]!.message).toContain("claude-code");
  });
});

describe("I-AUD2 assertArtifactLineage", () => {
  it("passes when present slots have uow_id and non-empty input_refs", () => {
    const findings = assertArtifactLineage([slot({ type: "patch_proposal" })]);
    expect(findings).toEqual([]);
  });

  it("skips absent slots (an absent slot is not a lineage violation)", () => {
    const findings = assertArtifactLineage([
      slot({ type: "patch_proposal", status: "absent", uow_id: "", input_refs: [] }),
    ]);
    expect(findings).toEqual([]);
  });

  it("flags a present artifact without uow_id", () => {
    const findings = assertArtifactLineage([slot({ type: "patch_proposal", uow_id: "" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("I-AUD2");
    expect(findings[0]!.message).toContain("no uow_id");
  });

  it("flags a lineage-required artifact with empty input_refs", () => {
    const findings = assertArtifactLineage([slot({ type: "test_run", input_refs: [] })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("I-AUD2");
    expect(findings[0]!.message).toContain("input_refs");
  });

  it("does NOT flag a lineage-optional artifact with empty input_refs", () => {
    const findings = assertArtifactLineage([slot({ type: "status_update", input_refs: [] })]);
    expect(findings).toEqual([]);
  });
});

describe("I-AUD3 assertGuardedTransition", () => {
  const baseTransition: GuardedTransition = {
    uow_id: "GH-1823",
    state_from: "pushed",
    state_to: "in_review",
    present_artifact_types: [],
  };

  it("passes when state_to has no required artifacts (non-workflow region)", () => {
    const findings = assertGuardedTransition({
      ...baseTransition,
      state_to: "merged",
      present_artifact_types: [],
    });
    expect(findings).toEqual([]);
  });

  it("passes when every required artifact is present", () => {
    // `in_review` requires patch_proposal + patch_check + guard_check +
    // test_plan + test_run + review_bundle per artifact_type meta.
    const findings = assertGuardedTransition({
      ...baseTransition,
      present_artifact_types: [
        "patch_proposal",
        "patch_check",
        "guard_check",
        "test_plan",
        "test_run",
        "review_bundle",
      ],
    });
    expect(findings).toEqual([]);
  });

  it("flags a transition missing a required artifact", () => {
    const findings = assertGuardedTransition({
      ...baseTransition,
      state_to: "ready_for_review",
      present_artifact_types: ["patch_proposal", "patch_check"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("I-AUD3");
    expect(findings[0]!.message).toContain("test_run");
    expect(findings[0]!.message).toContain("GH-1823");
  });
});

// The production "merge gate" behind the anchored-chain claim
// "artifacts license transitions; the merge gate is a verifier"
// (docs/anchored-chain/merge-gate-production.md). I-AUD3 at the
// `ready_to_merge` phase is the real gate; the parity-chain
// validateDerivation demo proved the mechanism, this proves the gate.
describe("merge gate (ready_to_merge) — anchored-chain claim", () => {
  const mergeTransition: GuardedTransition = {
    uow_id: "GH-1823",
    state_from: "in_review",
    state_to: "ready_to_merge",
    present_artifact_types: [],
  };

  it("the gate's definition is exactly test_run + review_bundle", () => {
    // Pin the contract: reaching ready_to_merge requires test evidence AND
    // review evidence. If this set changes, the merge gate changed.
    expect([...requiredArtifactTypesForPhase("ready_to_merge")].sort()).toEqual([
      "review_bundle",
      "test_run",
    ]);
  });

  it("REFUSES merge when review evidence is absent", () => {
    const findings = assertGuardedTransition({
      ...mergeTransition,
      present_artifact_types: ["test_run"], // tests passed, but no review
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("I-AUD3");
    expect(findings[0]!.message).toContain("review_bundle");
  });

  it("REFUSES merge when test evidence is absent", () => {
    const findings = assertGuardedTransition({
      ...mergeTransition,
      present_artifact_types: ["review_bundle"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("test_run");
  });

  it("REFUSES merge when both are absent (names both)", () => {
    const findings = assertGuardedTransition(mergeTransition);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("test_run");
    expect(findings[0]!.message).toContain("review_bundle");
  });

  it("LICENSES merge once both test_run and review_bundle are present", () => {
    const findings = assertGuardedTransition({
      ...mergeTransition,
      present_artifact_types: ["test_run", "review_bundle"],
    });
    expect(findings).toEqual([]);
  });

  // Known gap (the honest one): `present_artifact_types` is "types whose
  // status is present | passed" (see invariants.ts GuardedTransition), so a
  // review_bundle that merely *exists* (status=present, no pass/fail outcome
  // yet) satisfies the gate. The gate enforces PRESENCE, not a PASSED
  // outcome. This is METR's "passes tests ≠ merge-worthy" restated at the
  // code level; hardening the gate to require status=passed is the next step
  // (see merge-gate-production.md). This test locks current behavior so that
  // change is deliberate.
  it("currently licenses merge on presence alone (not a passed outcome)", () => {
    const findings = assertGuardedTransition({
      ...mergeTransition,
      present_artifact_types: ["test_run", "review_bundle"],
    });
    expect(findings).toEqual([]);
  });
});

describe("I-AUD4 assertNoAmbientGit", () => {
  it("passes when no events are ambient-git", () => {
    const findings = assertNoAmbientGit([
      ev({ actor: "prx", action: "audit ingest" }),
      ev({ actor: "git", action: "git push" }),
    ]);
    expect(findings).toEqual([]);
  });

  it("flags an agent-actor running git push", () => {
    const findings = assertNoAmbientGit([ev({ actor: "claude-code", action: "git push" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("I-AUD4");
    expect(findings[0]!.message).toContain("git push");
  });

  it("flags multiple ambient git mutations", () => {
    const findings = assertNoAmbientGit([
      ev({ actor: "codex", action: "git commit" }),
      ev({ actor: "agent.executor", action: "git reset --hard" }),
      ev({ actor: "git", action: "git push" }),
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.id === "I-AUD4")).toBe(true);
  });
});

describe("I-AUD5 assertDerivedStatus", () => {
  const base: DerivedUowStatus = {
    uow_id: "GH-1823",
    recorded_status: "in_review",
    derived_phase: "in_review",
  };

  it("passes when recorded_status equals derived_phase", () => {
    expect(assertDerivedStatus(base)).toEqual([]);
  });

  it("skips when recorded_status is null", () => {
    expect(assertDerivedStatus({ ...base, recorded_status: null })).toEqual([]);
  });

  it("flags a divergence between recorded_status and derived_phase", () => {
    const findings = assertDerivedStatus({
      ...base,
      recorded_status: "ready_for_review",
      derived_phase: "in_review",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("I-AUD5");
    expect(findings[0]!.message).toContain("diverges");
  });
});

// GH-1822 — Scrum-fit lifecycle + UoW-rooted invariant.
//
// Covers the four issue success criteria:
//   1. StatusUpdate references at least one UoW (uow_refs.min(1)).
//   2. BlockerReport carries owner + unblock_condition + severity (all three
//      required, severity bounded by the enum).
//   3. DelegationRecord is a typed artifact with `expected_output_type`
//      pinned to the audit vocabulary, so `prx delegate` writes typed.
//   4. SprintPlan.selected_uow_ids materializes sprint membership.
// Plus: axis-mismatch rejection on the TransitionContract, and the
// lifecycle-axis guards run end-to-end against an artifact graph.
//
// JSON-schema round-trip: the four schemas exported into
// `schemas/contracts/lifecycle/` carry the same `required` fields and
// `additionalProperties: false` posture as the Zod source of truth.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { transitionContractSchema } from "../../../src/machine/contracts.ts";
import {
  getArtifactContract,
  listArtifactContracts,
} from "../../../src/machine/contracts/artifacts.ts";
import {
  getAgentContract,
} from "../../../src/machine/contracts/instances.ts";
import {
  blockerReportSchema,
  delegationRecordSchema,
  sprintPlanSchema,
  statusUpdateSchema,
} from "../../../src/machine/contracts/lifecycle_artifacts.ts";
import {
  getTransitionContract,
} from "../../../src/machine/contracts/transitions.ts";
import { runGuard } from "../../../src/machine/contracts/guards.ts";

// ── Layer A: live Zod schemas (round-trip) ───────────────────────────────

describe("statusUpdate schema", () => {
  const valid = {
    unitId: "GH-1822",
    uow_refs: ["GH-1822"],
    body: "lifecycle spike landed",
    author: "rdi",
    ts: "2026-05-16T00:00:00Z",
  };

  test("accepts a well-formed statusUpdate", () => {
    expect(statusUpdateSchema.parse(valid).uow_refs).toEqual(["GH-1822"]);
  });

  test("rejects empty uow_refs (free-floating prose)", () => {
    expect(() =>
      statusUpdateSchema.parse({ ...valid, uow_refs: [] })
    ).toThrow();
  });

  test("rejects missing uow_refs entirely", () => {
    const { uow_refs: _drop, ...rest } = valid;
    expect(() => statusUpdateSchema.parse(rest)).toThrow();
  });

  test("rejects unknown extra fields (strict)", () => {
    expect(() =>
      statusUpdateSchema.parse({ ...valid, mood: "festive" })
    ).toThrow();
  });

  test("rejects malformed ts", () => {
    expect(() =>
      statusUpdateSchema.parse({ ...valid, ts: "yesterday" })
    ).toThrow();
  });
});

describe("blockerReport schema", () => {
  const valid = {
    unitId: "GH-1822",
    owner: "rdi",
    unblock_condition: "GH-1821 merges",
    severity: "high" as const,
    reason: "waiting on contract trinity",
  };

  test("accepts a well-formed blockerReport", () => {
    expect(blockerReportSchema.parse(valid).severity).toBe("high");
  });

  test("rejects missing owner", () => {
    const { owner: _drop, ...rest } = valid;
    expect(() => blockerReportSchema.parse(rest)).toThrow();
  });

  test("rejects missing unblock_condition", () => {
    const { unblock_condition: _drop, ...rest } = valid;
    expect(() => blockerReportSchema.parse(rest)).toThrow();
  });

  test("rejects an out-of-vocabulary severity", () => {
    expect(() =>
      blockerReportSchema.parse({ ...valid, severity: "annoying" })
    ).toThrow();
  });
});

describe("delegationRecord schema", () => {
  const valid = {
    unitId: "GH-1822",
    assigned_to: "agent.executor",
    expected_output_type: "patch_proposal" as const,
    capabilities: ["implement"],
    delegated_by: "rdi",
  };

  test("accepts a well-formed delegationRecord (no deadline)", () => {
    expect(delegationRecordSchema.parse(valid).expected_output_type).toBe(
      "patch_proposal",
    );
  });

  test("accepts an optional deadline", () => {
    const parsed = delegationRecordSchema.parse({
      ...valid,
      deadline: "2026-05-23T17:00:00Z",
    });
    expect(parsed.deadline).toBe("2026-05-23T17:00:00Z");
  });

  test("rejects expected_output_type outside the audit vocabulary", () => {
    expect(() =>
      delegationRecordSchema.parse({
        ...valid,
        expected_output_type: "wishful_thinking",
      })
    ).toThrow();
  });

  test("rejects missing assigned_to", () => {
    const { assigned_to: _drop, ...rest } = valid;
    expect(() => delegationRecordSchema.parse(rest)).toThrow();
  });
});

describe("sprintPlan schema", () => {
  const valid = {
    sprint_uow_id: "GH-SPRINT-1",
    selected_uow_ids: ["GH-1822", "GH-1823"],
    start_date: "2026-05-12",
    end_date: "2026-05-26",
  };

  test("accepts a well-formed sprintPlan", () => {
    expect(sprintPlanSchema.parse(valid).selected_uow_ids).toHaveLength(2);
  });

  test("accepts an optional capacity hint", () => {
    expect(sprintPlanSchema.parse({ ...valid, capacity: 21 }).capacity).toBe(
      21,
    );
  });

  test("rejects empty selected_uow_ids (sprint with no work)", () => {
    expect(() =>
      sprintPlanSchema.parse({ ...valid, selected_uow_ids: [] })
    ).toThrow();
  });

  test("rejects start_date after end_date", () => {
    expect(() =>
      sprintPlanSchema.parse({
        ...valid,
        start_date: "2026-05-26",
        end_date: "2026-05-12",
      })
    ).toThrow();
  });

  test("rejects calendar dates with a timestamp suffix", () => {
    expect(() =>
      sprintPlanSchema.parse({
        ...valid,
        start_date: "2026-05-12T00:00:00Z",
      })
    ).toThrow();
  });
});

// ── Layer B: artifact registry pivot ─────────────────────────────────────

describe("lifecycle artifact registry", () => {
  test("status_update is live and points at the lifecycle schema module", () => {
    const slot = getArtifactContract("status_update");
    expect(slot).toBeDefined();
    expect(slot!.validationRef).toMatch(/lifecycle_artifacts\.ts#statusUpdate/);
  });

  test("blocker_report is live (promoted from deferred)", () => {
    const slot = getArtifactContract("blocker_report");
    expect(slot).toBeDefined();
    expect(slot!.validationRef).toMatch(/lifecycle_artifacts\.ts#blockerReport/);
  });

  test("delegation_record is live", () => {
    const slot = getArtifactContract("delegation_record");
    expect(slot).toBeDefined();
    expect(slot!.validationRef).toMatch(/lifecycle_artifacts\.ts#delegationRecord/);
  });

  test("sprint_plan is live", () => {
    const slot = getArtifactContract("sprint_plan");
    expect(slot).toBeDefined();
    expect(slot!.validationRef).toMatch(/lifecycle_artifacts\.ts#sprintPlan/);
  });

  test("eight deferred placeholders cite GH-1822", () => {
    const deferredNames = [
      "uow_candidate",
      "work_map",
      "acceptance_record",
      "followup_uow",
      "process_change_proposal",
      "retro_note",
      "sprint_digest",
      "stakeholder_summary",
    ] as const;
    for (const name of deferredNames) {
      const slot = getArtifactContract(name);
      expect(slot).toBeDefined();
      expect(slot!.validationRef).toBe("deferred:GH-1822");
    }
  });

  test("context_bundle no longer cites GH-1822", () => {
    const slot = getArtifactContract("context_bundle");
    expect(slot).toBeDefined();
    expect(slot!.validationRef).not.toBe("deferred:GH-1822");
  });
});

// ── Layer C: lifecycle-axis agent roles ──────────────────────────────────

describe("lifecycle management AgentContracts", () => {
  test("map: uow → work_map", () => {
    const c = getAgentContract("map")!;
    expect(c.inputArtifact).toBe("uow");
    expect(c.outputArtifact).toBe("work_map");
  });

  test("delegate: work_map → delegation_record", () => {
    const c = getAgentContract("delegate")!;
    expect(c.inputArtifact).toBe("work_map");
    expect(c.outputArtifact).toBe("delegation_record");
  });

  test("report: uow → status_update", () => {
    const c = getAgentContract("report")!;
    expect(c.inputArtifact).toBe("uow");
    expect(c.outputArtifact).toBe("status_update");
  });

  test("retro: sprint_plan → retro_note", () => {
    const c = getAgentContract("retro")!;
    expect(c.inputArtifact).toBe("sprint_plan");
    expect(c.outputArtifact).toBe("retro_note");
  });
});

// ── Layer D: lifecycle-axis TransitionContracts + guards ─────────────────

describe("lifecycle-axis transitions", () => {
  test("lifecycle:map->delegate is registered", () => {
    const t = getTransitionContract("lifecycle:map->delegate")!;
    expect(t.axis).toBe("lifecycle");
    expect(t.requiredArtifact).toBe("work_map");
    expect(t.forbiddenArtifacts).toContain("blocker_report");
  });

  test("lifecycle:delegate->execute is registered", () => {
    const t = getTransitionContract("lifecycle:delegate->execute")!;
    expect(t.axis).toBe("lifecycle");
    expect(t.requiredArtifact).toBe("delegation_record");
  });

  test("transitionContractSchema accepts axis=lifecycle", () => {
    const parsed = transitionContractSchema.parse({
      axis: "lifecycle",
      fromPhase: "map",
      toPhase: "delegate",
      requiredArtifact: "work_map",
      requiredStatus: "present",
      forbiddenArtifacts: ["blocker_report"],
      guardId: "mapToDelegate.requireWorkMap",
    });
    expect(parsed.axis).toBe("lifecycle");
  });

  test("transitionContractSchema rejects unknown axis (mismatch)", () => {
    expect(() =>
      transitionContractSchema.parse({
        axis: "stakeholder",
        fromPhase: "map",
        toPhase: "delegate",
        requiredArtifact: "work_map",
        requiredStatus: "present",
        forbiddenArtifacts: [],
        guardId: "mapToDelegate.requireWorkMap",
      })
    ).toThrow();
  });

  test("mapToDelegate guard returns ok when work_map present", () => {
    const contract = getTransitionContract("lifecycle:map->delegate")!;
    const verdict = runGuard({
      graph: { work_map: { status: "present" } },
      contract,
    });
    expect(verdict.ok).toBe(true);
  });

  test("mapToDelegate guard rejects when blocker_report present", () => {
    const contract = getTransitionContract("lifecycle:map->delegate")!;
    const verdict = runGuard({
      graph: {
        work_map: { status: "present" },
        blocker_report: { status: "present" },
      },
      contract,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/blocker_report/);
  });

  test("mapToDelegate guard rejects when work_map missing", () => {
    const contract = getTransitionContract("lifecycle:map->delegate")!;
    const verdict = runGuard({ graph: {}, contract });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/missing/);
  });

  test("delegateToExecute guard returns ok when delegation_record present", () => {
    const contract = getTransitionContract("lifecycle:delegate->execute")!;
    const verdict = runGuard({
      graph: { delegation_record: { status: "present" } },
      contract,
    });
    expect(verdict.ok).toBe(true);
  });

  test("delegateToExecute guard rejects when delegation_record missing", () => {
    const contract = getTransitionContract("lifecycle:delegate->execute")!;
    const verdict = runGuard({ graph: {}, contract });
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/missing/);
  });
});

// ── Layer E: JSON-schema export parity ───────────────────────────────────

describe("JSON-schema exports for lifecycle artifacts", () => {
  const here = resolve(import.meta.dir, "../../..");
  const readJson = (path: string) =>
    JSON.parse(readFileSync(resolve(here, path), "utf8"));

  test("status-update.json mirrors required fields", () => {
    const schema = readJson("schemas/contracts/lifecycle/status-update.json");
    const def = schema.definitions.status_update;
    expect(def.required).toEqual([
      "unitId",
      "uow_refs",
      "body",
      "author",
      "ts",
    ]);
    expect(def.additionalProperties).toBe(false);
  });

  test("blocker-report.json carries severity enum", () => {
    const schema = readJson("schemas/contracts/lifecycle/blocker-report.json");
    const def = schema.definitions.blocker_report;
    expect(def.properties.severity.enum).toEqual([
      "low",
      "med",
      "high",
      "critical",
    ]);
  });

  test("delegation-record.json pins expected_output_type to the audit vocabulary", () => {
    const schema = readJson(
      "schemas/contracts/lifecycle/delegation-record.json",
    );
    const def = schema.definitions.delegation_record;
    expect(def.properties.expected_output_type.enum).toContain("patch_proposal");
    expect(def.properties.expected_output_type.enum).toContain("test_run");
  });

  test("sprint-plan.json enforces selected_uow_ids.minItems = 1", () => {
    const schema = readJson("schemas/contracts/lifecycle/sprint-plan.json");
    const def = schema.definitions.sprint_plan;
    expect(def.properties.selected_uow_ids.minItems).toBe(1);
  });
});

// ── Layer F: registry coverage ───────────────────────────────────────────

describe("registry coverage", () => {
  test("artifact count grew by exactly 13 entries (GH-1822 +11, GH-2326 +1, GH-2394 +1)", () => {
    // GH-1821 registered 35 artifacts. GH-1822 registers 12 new entries
    // (4 live + 8 deferred), and promotes the existing `blocker_report`
    // deferred entry to live (no net change in count). Net: +11.
    // GH-2326 adds the gc role's output artifact (gc_report): +1.
    // GH-2394 adds the scratch session's self-edge artifact (scratch_session): +1.
    const all = listArtifactContracts();
    expect(all.length).toBe(35 + 11 + 1 + 1);
  });
});

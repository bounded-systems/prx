import { describe, expect, test } from "bun:test";

import {
  assertSprintInvariants,
  createSprintState,
  deriveExecutionProgress,
  deriveOutcomeStatus,
  deriveSprintStatus,
  refreshSprintDerived,
  sprintStateV1Schema,
} from "../../src/pr-state/sprint.ts";
import type { WorkUnitId } from "@bounded-systems/machine-schema";

describe("SprintX machine", () => {
  test("parses a valid minimal sprint", () => {
    const state = createSprintState({
      sprintId: "sprint_2026_w11",
      week: { startDate: "2026-03-16", endDate: "2026-03-22" },
      goal: { summary: "Reduce lag", metricName: "p90_latency", targetDelta: -10 },
    });
    expect(state.sprintId).toBe("sprint_2026_w11");
    expect(state.derived.sprintStatus).toBe("planning");
  });

  test("deriveExecutionProgress counts merged, ready, blocked, inProgress", () => {
    const progress = deriveExecutionProgress([
      { number: 1, state: "merged", draft: false, checks: "green", review: "approved", mergeable: "mergeable" },
      { number: 2, state: "open", draft: false, checks: "green", review: "approved", mergeable: "mergeable" },
      { number: 3, state: "open", draft: false, checks: "red", review: "review_required", mergeable: "unknown" },
      { number: 4, state: "open", draft: true, checks: "pending", review: "review_required", mergeable: "unknown" },
    ]);
    expect(progress).toMatchObject({
      total: 4,
      merged: 1,
      ready: 1,
      blocked: 1,
      inProgress: 1,
    });
  });

  test("hard metric gate controls outcome and complete status", () => {
    const outcome = deriveOutcomeStatus({ baseline: 100, current: 85, targetDelta: -10 });
    expect(outcome).toBe("met_target");
    const sprintStatus = deriveSprintStatus(
      { total: 2, merged: 2, blocked: 0, inProgress: 0 },
      outcome,
    );
    expect(sprintStatus).toBe("complete");
  });

  test("metric regression produces outcome_failed", () => {
    const outcome = deriveOutcomeStatus({ baseline: 100, current: 120, targetDelta: -10 });
    expect(outcome).toBe("failed_target");
    const sprintStatus = deriveSprintStatus(
      { total: 2, merged: 2, blocked: 0, inProgress: 0 },
      outcome,
    );
    expect(sprintStatus).toBe("outcome_failed");
  });

  test("invariants fail on duplicate binding and complete-without-metric", () => {
    const base = createSprintState({
      sprintId: "sprint_2026_w11",
      week: { startDate: "2026-03-16", endDate: "2026-03-22" },
      goal: { summary: "Reduce lag", metricName: "p90_latency", targetDelta: -10 },
    });
    const invalid = {
      ...base,
      bindings: {
        ...base.bindings,
        prNumbers: [10, 10],
      },
      derived: {
        ...base.derived,
        sprintStatus: "complete" as const,
        outcomeStatus: "on_track" as const,
      },
    };
    const report = assertSprintInvariants(invalid);
    expect(report.valid).toBeFalse();
    expect(report.findings.map((f) => f.id)).toContain("S01");
    expect(report.findings.map((f) => f.id)).toContain("S06");
  });

  test("schema rejects non-canonical ticket/unit identifiers", () => {
    const base = createSprintState({
      sprintId: "sprint_2026_w11",
      week: { startDate: "2026-03-16", endDate: "2026-03-22" },
      goal: { summary: "Reduce lag", metricName: "p90_latency", targetDelta: -10 },
    });
    expect(() =>
      sprintStateV1Schema.parse({
        ...base,
        bindings: {
          ...base.bindings,
          ticketIds: ["feature/GH-1234"],
          unitIds: ["gh-5678"],
        },
      }),
    ).toThrow();
  });

  test("refreshSprintDerived computes executing then complete", () => {
    const initial = createSprintState({
      sprintId: "sprint_2026_w11",
      week: { startDate: "2026-03-16", endDate: "2026-03-22" },
      goal: { summary: "Reduce lag", metricName: "p90_latency", targetDelta: -10 },
    });
    const withMetric = {
      ...initial,
      metric: { ...initial.metric, baseline: 100, current: 95 },
      bindings: { ...initial.bindings, prNumbers: [1, 2], ticketIds: ["GH-1" as WorkUnitId], unitIds: [] },
    };
    const executing = refreshSprintDerived(withMetric, [
      { number: 1, state: "open", draft: false, checks: "green", review: "approved", mergeable: "mergeable" },
      { number: 2, state: "open", draft: false, checks: "pending", review: "review_required", mergeable: "unknown" },
    ]);
    expect(executing.derived.sprintStatus).toBe("executing");

    const complete = refreshSprintDerived(
      { ...executing, metric: { ...executing.metric, current: 85 } },
      [
        { number: 1, state: "merged", draft: false, checks: "green", review: "approved", mergeable: "mergeable" },
        { number: 2, state: "merged", draft: false, checks: "green", review: "approved", mergeable: "mergeable" },
      ],
    );
    expect(complete.derived.sprintStatus).toBe("complete");
  });
});

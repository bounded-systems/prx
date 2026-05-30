// GH-1510 Phase D — projection writer (bd → GH-Project) tests.
//
// I-PROJ1 invariant: the projection writer never reads GH-Project fields
// back into the bd-canonical state. The runner-injection seam in
// `projectBdToGhProject` exists for future live writes; these tests verify
// it is never invoked during report composition.

import { describe, expect, test } from "bun:test";

import type { NextWorkResult } from "../../src/beads/ready.ts";
import {
  formatProjectionReport,
  projectBdToGhProject,
  ProjectionWriteReportSchema,
  type GhRunner,
} from "../../src/projection/gh_project.ts";
import type { GithubProjectConfig } from "../../src/pr-state/github.ts";

const POPULATED: NextWorkResult = {
  source: "next-work",
  repo: "owner/repo",
  threads: [
    {
      kind: "ready_to_start",
      candidates: [
        {
          bd_id: "ai-home-r1",
          gh_issue: 9001,
          title: "Ready feature",
          priority: 1,
          issue_type: "feature",
          branch: null,
          worktree_path: null,
          status: "open",
          blocked_by: [],
          reason: "no blockers",
          command: "prx session open --create GH-9001",
        },
        {
          bd_id: "ai-home-bd-only",
          gh_issue: null,
          title: "bd-only — no GH mirror",
          priority: 2,
          issue_type: "task",
          branch: null,
          worktree_path: null,
          status: "open",
          blocked_by: [],
          reason: "no blockers",
          command: "prx session open --create ai-home-bd-only",
        },
      ],
      recommended_action: "prx session open --create GH-9001",
      cost_of_context_switch: "high",
      reason: "bd-ready with no blockers",
    },
    {
      kind: "blocked",
      candidates: [
        {
          bd_id: "ai-home-b1",
          gh_issue: 9100,
          title: "Blocked feature",
          priority: 1,
          issue_type: "feature",
          branch: null,
          worktree_path: null,
          status: "open",
          blocked_by: ["ai-home-r1"],
          reason: "Blocked by ai-home-r1",
          command: null,
        },
      ],
      recommended_action: "Unblock the highest-priority blocked bead",
      cost_of_context_switch: "medium",
      reason: "Has at least one open blocker",
    },
  ],
  cache: {
    queried_at: "2026-05-13T00:00:00.000+00:00",
    stale: false,
    ttl_seconds: 60,
    refreshed: false,
  },
};

function projectConfig(overrides: Partial<GithubProjectConfig> = {}): GithubProjectConfig {
  return { owner: "bdelanghe", number: 5, ...overrides };
}

describe("projectBdToGhProject", () => {
  test("emits one row per bd candidate joined with a GH issue", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig());
    expect(report.enabled).toBe(true);
    expect(report.rows.find((r) => r.bd_id === "ai-home-r1")?.action).toBe("updated");
    expect(report.rows.find((r) => r.bd_id === "ai-home-b1")?.action).toBe("updated");
  });

  test("bd records with no GH mirror are surfaced as `skipped`", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig());
    const bdOnly = report.rows.find((r) => r.bd_id === "ai-home-bd-only");
    expect(bdOnly?.action).toBe("skipped");
    expect(bdOnly?.reason).toMatch(/no GH issue/i);
  });

  test("Status field reflects the thread → project Status mapping", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig());
    const r1 = report.rows.find((r) => r.bd_id === "ai-home-r1");
    expect(r1?.diffs.find((d) => d.field === "Status")?.after).toBe("Ready");
    const b1 = report.rows.find((r) => r.bd_id === "ai-home-b1");
    expect(b1?.diffs.find((d) => d.field === "Status")?.after).toBe("Blocked");
  });

  test("Priority field maps numeric bd priority to a label", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig());
    const r1 = report.rows.find((r) => r.bd_id === "ai-home-r1");
    expect(r1?.diffs.find((d) => d.field === "Priority")?.after).toBe("High");
  });

  test("when config.owner is null the report is disabled with zero rows", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig({ owner: null }));
    expect(report.enabled).toBe(false);
    expect(report.rows).toHaveLength(0);
  });

  test("when config.number is null the report is disabled with zero rows", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig({ number: null }));
    expect(report.enabled).toBe(false);
    expect(report.rows).toHaveLength(0);
  });

  test("budget block tracks the requested live-write count", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig(), undefined, { threshold: 50 });
    expect(report.budget.threshold).toBe(50);
    expect(report.budget.requested).toBe(2); // r1, b1 — bd-only is skipped
  });

  test("output validates against the Zod schema", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig());
    expect(() => ProjectionWriteReportSchema.parse(report)).not.toThrow();
  });

  test("I-PROJ1: the GhRunner is never invoked during report composition", () => {
    let runnerCalls = 0;
    const recordingRunner: GhRunner = () => {
      runnerCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    projectBdToGhProject(POPULATED, projectConfig(), recordingRunner);
    expect(runnerCalls).toBe(0);
  });
});

describe("formatProjectionReport", () => {
  test("disabled config renders the no-pin message", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig({ owner: null }));
    expect(formatProjectionReport(report, "plain")).toContain("disabled");
  });

  test("plain output includes per-row diffs", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig());
    const out = formatProjectionReport(report, "plain");
    expect(out).toContain("ai-home-r1");
    expect(out).toContain("Status=Ready");
    expect(out).toContain("Priority=High");
  });

  test("JSON output round-trips through the schema", () => {
    const report = projectBdToGhProject(POPULATED, projectConfig());
    const json = formatProjectionReport(report, "json");
    const parsed = JSON.parse(json);
    expect(() => ProjectionWriteReportSchema.parse(parsed)).not.toThrow();
  });
});

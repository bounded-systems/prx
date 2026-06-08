import { describe, expect, test } from "bun:test";

import { formatSurfaceSync, type SurfaceSyncResult } from "@bounded-systems/surface-sync";

function pruneResult(
  unit: SurfaceSyncResult["units"][number],
): SurfaceSyncResult {
  return {
    source: "surface-sync",
    repo: "owner/repo",
    mode: "prune",
    authority: "issue",
    scope: "local",
    apply: false,
    units: [unit],
    actions: unit.actions,
  };
}

describe("formatSurfaceSync — GH-2147 blockers", () => {
  test("plain: surfaces a blocker on a unit with zero actions instead of 'no actions'", () => {
    const out = formatSurfaceSync(
      pruneResult({
        branch: "GH-1",
        ticket: "GH-1",
        actions: [],
        blockers: ["worktree has uncommitted changes — refusing to prune."],
      }),
      "plain",
    );
    expect(out).not.toContain("No reconciliation actions required");
    expect(out).toContain("GH-1 ticket=GH-1");
    expect(out).toContain("! blocked: worktree has uncommitted changes — refusing to prune.");
  });

  test("plain: renders blockers alongside actions on the same unit", () => {
    const out = formatSurfaceSync(
      pruneResult({
        branch: "GH-2",
        ticket: "GH-2",
        actions: [
          { type: "delete_local_branch", branch: "GH-2", ticket: "GH-2", reason: "orphan" },
        ],
        blockers: ["worktree has uncommitted changes — refusing to prune."],
      }),
      "plain",
    );
    expect(out).toContain("  - delete_local_branch: orphan");
    expect(out).toContain("  ! blocked: worktree has uncommitted changes — refusing to prune.");
  });

  test("plain: unchanged 'no actions' message when there are neither actions nor blockers", () => {
    const out = formatSurfaceSync(
      pruneResult({ branch: "GH-3", ticket: "GH-3", actions: [] }),
      "plain",
    );
    expect(out).toContain("No reconciliation actions required");
  });

  test("json: blockers round-trip in the serialized payload", () => {
    const out = formatSurfaceSync(
      pruneResult({
        branch: "GH-4",
        ticket: "GH-4",
        actions: [],
        blockers: ["worktree is dirty"],
      }),
      "json",
    );
    expect(JSON.parse(out).units[0].blockers).toEqual(["worktree is dirty"]);
  });
});

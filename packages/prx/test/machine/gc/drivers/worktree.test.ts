/**
 * gc `worktree` driver (GH-2331 / ai-home-q8h6y) — offline unit tests.
 *
 * Stubs `buildParityChain` (keyed on the `apply` flag so mark/sweep can return
 * different action sets — exercises the TOCTOU guard) and `applyParityChainActions`
 * (records that it ran + yields per-action statuses). No git.
 */
import { describe, expect, test } from "bun:test";

import type { SurfaceSyncAction, SurfaceSyncResult } from "@bounded-systems/surface-sync";

import { markFindings } from "../../../../src/machine/gc/capability.ts";
import { createWorktreeDriver } from "../../../../src/machine/gc/drivers/worktree.ts";
import type { GcDriverDeps } from "../../../../src/machine/gc/drivers/registry.ts";

function chain(actions: SurfaceSyncAction[]): SurfaceSyncResult {
  return {
    source: "surface-sync",
    repo: "test-owner/test-repo",
    mode: "prune",
    authority: "local",
    scope: "all",
    apply: false,
    units: [],
    actions,
  };
}

const dw = (ticket: string | null, branch = "feat-x"): SurfaceSyncAction => ({
  type: "delete_worktree",
  branch,
  ticket,
  reason: "PR merged and issue closed",
});

/** Driver deps: `mark` chain on the dry plan, `sweep` chain on the apply plan. */
function wtDeps(opts: {
  mark: SurfaceSyncAction[];
  sweep?: SurfaceSyncAction[];
  applyStatuses?: number[];
  noApply?: boolean;
}): { deps: GcDriverDeps; applied: () => boolean } {
  const sweepActions = opts.sweep ?? opts.mark;
  const state = { applied: false };
  const deps = {
    repoPath: "/tmp/gc-wt-test",
    buildParityChain: (_repo: string, o?: { apply?: boolean }) =>
      chain(o?.apply ? sweepActions : opts.mark),
    ...(opts.noApply
      ? {}
      : {
          applyParityChainActions: (summary: SurfaceSyncResult) => {
            state.applied = true;
            return summary.actions.map((action, i) => ({
              action,
              command: `noop-${action.type}`,
              status: (opts.applyStatuses ?? [])[i] ?? 0,
              stdout: "",
              stderr:
                action.type === "delete_worktree" && (opts.applyStatuses ?? [])[i] ? "locked" : "",
            }));
          },
        }),
  } as unknown as GcDriverDeps;
  return { deps, applied: () => state.applied };
}

describe("createWorktreeDriver — mark", () => {
  test("filters to delete_worktree and maps ref=ticket, class=orphan", async () => {
    const { deps } = wtDeps({
      mark: [
        dw("GH-1"),
        { type: "delete_local_branch", branch: "GH-1", ticket: "GH-1", reason: "merged" },
      ],
    });
    const findings = await createWorktreeDriver(deps).mark();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      component: "worktree",
      class: "orphan",
      ref: "GH-1",
      detail: "PR merged and issue closed",
    });
  });

  test("ref falls back to branch when ticket is null", async () => {
    const { deps } = wtDeps({ mark: [dw(null, "feat-detached")] });
    const findings = await createWorktreeDriver(deps).mark();
    expect(findings[0]?.ref).toBe("feat-detached");
  });
});

describe("createWorktreeDriver — sweep", () => {
  test("applies the marked worktrees and reports them reclaimed", async () => {
    const { deps, applied } = wtDeps({ mark: [dw("GH-1"), dw("GH-2", "GH-2")] });
    const driver = createWorktreeDriver(deps);
    const findings = await driver.mark();
    const out = await driver.sweep(markFindings("worktree", findings), {});
    expect(applied()).toBe(true);
    expect(out.reclaimed.map((f) => f.ref).sort()).toEqual(["GH-1", "GH-2"]);
    expect(out.failed).toBeUndefined();
  });

  test("TOCTOU: a worktree that left the reclaimable set between phases is not swept", async () => {
    // marked two, but the phase-2 (apply) plan only still lists one.
    const { deps } = wtDeps({ mark: [dw("GH-1"), dw("GH-2", "GH-2")], sweep: [dw("GH-1")] });
    const driver = createWorktreeDriver(deps);
    const out = await driver.sweep(markFindings("worktree", await driver.mark()), {});
    expect(out.reclaimed.map((f) => f.ref)).toEqual(["GH-1"]);
  });

  test("a locked/dirty worktree refusal (non-zero status) → failed, not reclaimed", async () => {
    const { deps } = wtDeps({ mark: [dw("GH-1")], applyStatuses: [1] });
    const driver = createWorktreeDriver(deps);
    const out = await driver.sweep(markFindings("worktree", await driver.mark()), {});
    expect(out.reclaimed).toEqual([]);
    expect(out.failed).toContain("GH-1");
  });

  test("empty mark → no-op, never calls apply (idempotent re-run)", async () => {
    const { deps, applied } = wtDeps({ mark: [] });
    const out = await createWorktreeDriver(deps).sweep(markFindings("worktree", []), {});
    expect(out.reclaimed).toEqual([]);
    expect(applied()).toBe(false);
  });

  test("missing applyParityChainActions dep → failed guard, no throw", async () => {
    const { deps } = wtDeps({ mark: [dw("GH-1")], noApply: true });
    const driver = createWorktreeDriver(deps);
    const out = await driver.sweep(markFindings("worktree", await driver.mark()), {});
    expect(out.reclaimed).toEqual([]);
    expect(out.failed).toContain("applyParityChainActions");
  });
});

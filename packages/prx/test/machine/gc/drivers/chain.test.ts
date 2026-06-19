/**
 * gc `chain` driver (GH-2331 / tywg6) — offline unit + actor round-trip tests.
 *
 * Stubs `buildParityChain` (keyed on `apply` so mark/sweep can differ →
 * exercises the TOCTOU guard) + `applyParityChainActions`. No git. Covers: the
 * branch-action filter, the live-worktree ordering guard (defer a local branch
 * whose unit still has a worktree in the plan), per-action apply failures →
 * `partial`, and that `chain` is gated as a destructive component.
 */
import { describe, expect, test } from "bun:test";

import type { SurfaceSyncAction, SurfaceSyncResult } from "@bounded-systems/surface-sync";

import { markFindings } from "../../../../src/machine/gc/capability.ts";
import { createChainDriver } from "../../../../src/machine/gc/drivers/chain.ts";
import type { GcDriverDeps } from "../../../../src/machine/gc/drivers/registry.ts";
import { runInventory, runRun, type GcSweepDeps } from "../../../../src/machine/gc/actor.ts";

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

const dw = (ticket: string): SurfaceSyncAction => ({
  type: "delete_worktree",
  branch: ticket,
  ticket,
  reason: "PR merged and issue closed",
});
const dlb = (ticket: string): SurfaceSyncAction => ({
  type: "delete_local_branch",
  branch: ticket,
  ticket,
  reason: "merged",
});
const drb = (ticket: string): SurfaceSyncAction => ({
  type: "delete_remote_branch",
  branch: ticket,
  ticket,
  reason: "merged",
});

/** Driver deps: `mark` chain on the dry plan, `sweep` chain on the apply plan. */
function chDeps(opts: {
  mark: SurfaceSyncAction[];
  sweep?: SurfaceSyncAction[];
  applyStatuses?: number[];
  noApply?: boolean;
}): { deps: GcDriverDeps; applied: () => boolean } {
  const sweepActions = opts.sweep ?? opts.mark;
  const state = { applied: false };
  const deps = {
    repoPath: "/tmp/gc-chain-test",
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
              stderr: (opts.applyStatuses ?? [])[i] ? "checked out" : "",
            }));
          },
        }),
  } as unknown as GcDriverDeps;
  return { deps, applied: () => state.applied };
}

describe("createChainDriver — mark", () => {
  test("filters to branch actions; ref=scope:branch, class=orphan", async () => {
    const { deps } = chDeps({ mark: [dlb("GH-2"), drb("GH-2"), dw("GH-9")] });
    const findings = await createChainDriver(deps).mark();
    expect(findings.map((f) => f.ref).sort()).toEqual(["local:GH-2", "remote:GH-2"]);
    expect(findings.every((f) => f.component === "chain" && f.class === "orphan")).toBe(true);
  });

  test("ordering guard: defers a local branch whose unit still has a worktree; keeps its remote", async () => {
    // GH-1 still has a worktree (dw present) → its local delete is deferred;
    // GH-2 has no worktree → both local + remote eligible.
    const { deps } = chDeps({
      mark: [dw("GH-1"), dlb("GH-1"), drb("GH-1"), dlb("GH-2"), drb("GH-2")],
    });
    const findings = await createChainDriver(deps).mark();
    expect(findings.map((f) => f.ref).sort()).toEqual(["local:GH-2", "remote:GH-1", "remote:GH-2"]);
  });

  test("no branch actions → no findings", async () => {
    const { deps } = chDeps({ mark: [dw("GH-9")] });
    expect(await createChainDriver(deps).mark()).toEqual([]);
  });
});

describe("createChainDriver — sweep", () => {
  test("applies the marked branch actions and reclaims them", async () => {
    const { deps, applied } = chDeps({ mark: [dlb("GH-2"), drb("GH-2")] });
    const driver = createChainDriver(deps);
    const mark = markFindings("chain", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(failed).toBeUndefined();
    expect(reclaimed.map((f) => f.ref).sort()).toEqual(["local:GH-2", "remote:GH-2"]);
    expect(applied()).toBe(true);
  });

  test("TOCTOU: a branch gone from the live plan since mark is not swept", async () => {
    const { deps } = chDeps({
      mark: [drb("GH-2"), drb("GH-3")],
      sweep: [drb("GH-2")], // GH-3's remote branch went away between phases
    });
    const driver = createChainDriver(deps);
    const mark = markFindings("chain", await driver.mark());
    const { reclaimed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["remote:GH-2"]);
  });

  test("a per-action apply failure → partial (reclaimed + failed)", async () => {
    const { deps } = chDeps({
      mark: [dlb("GH-2"), drb("GH-2")],
      applyStatuses: [1, 0], // local delete fails (e.g. still checked out elsewhere)
    });
    const driver = createChainDriver(deps);
    const mark = markFindings("chain", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["remote:GH-2"]);
    expect(failed).toContain("local:GH-2");
  });

  test("missing applyParityChainActions → failed", async () => {
    const { deps } = chDeps({ mark: [drb("GH-2")], noApply: true });
    const driver = createChainDriver(deps);
    const mark = markFindings("chain", await driver.mark());
    const out = await driver.sweep(mark, {});
    expect(out.reclaimed).toEqual([]);
    expect(out.failed).toContain("applyParityChainActions");
  });
});

describe("chain driver — actor fan-out (destructive gate)", () => {
  test("inventory --component chain reports the orphan branches", async () => {
    const out = await runInventory(
      { component: "chain" },
      chDeps({ mark: [drb("GH-2")] }).deps as GcSweepDeps,
    );
    expect(out.status).toBe("reclaimable");
    expect(out.by_class.orphan).toBe(1);
  });

  test("run --component chain --apply WITHOUT a token → capability-required, not applied", async () => {
    const d = chDeps({ mark: [drb("GH-2")] });
    const out = await runRun({ component: "chain", apply: true }, d.deps as GcSweepDeps);
    expect(out.status).toBe("capability-required");
    expect(out.reclaimed).toEqual([]);
    expect(d.applied()).toBe(false);
  });

  test("run --component chain --apply WITH gc:delete → swept, applied", async () => {
    const d = chDeps({ mark: [drb("GH-2")] });
    const out = await runRun(
      { component: "chain", apply: true, capability: "gc:delete" },
      d.deps as GcSweepDeps,
    );
    expect(out.status).toBe("swept");
    expect(out.reclaimed.map((f) => f.ref)).toEqual(["remote:GH-2"]);
    expect(d.applied()).toBe(true);
  });
});

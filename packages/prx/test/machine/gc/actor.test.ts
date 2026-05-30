/**
 * gc actor fan-out (GH-2331 `tywg6`) — runInventory/runRun over the driver
 * registry. Driven through the real `buildGcRegistry` (so the `worktree` driver
 * is the vehicle) with stubbed `buildParityChain`/`applyParityChainActions`
 * deps. Asserts the capability gate, dry-run vs apply, status taxonomy, and
 * failure isolation. No git.
 */
import { describe, expect, test } from "bun:test";

import type {
  SurfaceSyncAction,
  SurfaceSyncResult,
} from "@bounded-systems/surface-sync";

import { runInventory, runRun, type GcSweepDeps } from "../../../src/machine/gc/actor.ts";
import type { CasGcOps } from "../../../src/machine/gc/drivers/registry.ts";

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

const dw = (ticket = "GH-1"): SurfaceSyncAction => ({
  type: "delete_worktree",
  branch: ticket,
  ticket,
  reason: "merged",
});

function deps(opts: {
  actions?: SurfaceSyncAction[];
  applyStatuses?: number[];
  throws?: boolean;
}): { deps: GcSweepDeps; applied: () => boolean } {
  const state = { applied: false };
  const d = {
    repoPath: "/tmp/gc-actor-test",
    buildParityChain: () => {
      if (opts.throws) throw new Error("buildParityChain boom");
      return chain(opts.actions ?? []);
    },
    applyParityChainActions: (summary: SurfaceSyncResult) => {
      state.applied = true;
      return summary.actions.map((action, i) => ({
        action,
        command: "noop",
        status: (opts.applyStatuses ?? [])[i] ?? 0,
        stdout: "",
        stderr: "",
      }));
    },
  } as unknown as GcSweepDeps;
  return { deps: d, applied: () => state.applied };
}

describe("runInventory — fan-out", () => {
  test("nothing reclaimable → clean", async () => {
    const out = await runInventory({}, deps({ actions: [] }).deps);
    expect(out.status).toBe("clean");
    expect(out.findings).toEqual([]);
  });

  test("a reclaimable worktree → reclaimable, by_class.orphan", async () => {
    const out = await runInventory({ component: "worktree" }, deps({ actions: [dw()] }).deps);
    expect(out.status).toBe("reclaimable");
    expect(out.by_class.orphan).toBe(1);
  });

  test("a driver throwing → error (all attempted failed)", async () => {
    const out = await runInventory({ component: "worktree" }, deps({ throws: true }).deps);
    expect(out.status).toBe("error");
    expect(out.error).toContain("worktree");
  });
});

describe("runRun — fan-out + capability gate", () => {
  test("dry-run with a reclaimable worktree → would-sweep, not applied", async () => {
    const d = deps({ actions: [dw()] });
    const out = await runRun({ apply: false }, d.deps);
    expect(out.status).toBe("would-sweep");
    expect(out.dry_run).toBe(true);
    expect(out.reclaimed).toHaveLength(1);
    expect(d.applied()).toBe(false);
  });

  test("apply on a destructive component WITHOUT a token → capability-required, not applied", async () => {
    const d = deps({ actions: [dw()] });
    const out = await runRun({ apply: true }, d.deps);
    expect(out.status).toBe("capability-required");
    expect(out.reclaimed).toEqual([]);
    expect(d.applied()).toBe(false);
  });

  test("apply WITH the gc:delete token → swept, applied", async () => {
    const d = deps({ actions: [dw()] });
    const out = await runRun({ apply: true, capability: "gc:delete" }, d.deps);
    expect(out.status).toBe("swept");
    expect(out.reclaimed).toHaveLength(1);
    expect(d.applied()).toBe(true);
  });

  test("apply WITH token but nothing reclaimable → clean", async () => {
    const out = await runRun({ apply: true, capability: "gc:delete" }, deps({ actions: [] }).deps);
    expect(out.status).toBe("clean");
  });

  test("a driver throws (scoped, all attempted failed) → error", async () => {
    const out = await runRun({ component: "worktree", apply: false }, deps({ throws: true }).deps);
    expect(out.status).toBe("error");
    expect(out.failed.map((f) => f.component)).toContain("worktree");
  });

  test("fans out to the cas driver: stub cas + token → swept, cas finding reclaimed", async () => {
    const deleted: string[] = [];
    // Domain-aware: the one orphan lives in the plans domain only (the cas
    // driver queries plans + submit, so submit must come back empty).
    const cas = {
      listRefs: async () => [], // no refs → the plans blob is orphan
      readBlob: async () => Buffer.from(""),
      listBlobs: async (opts?: { domain?: string }) =>
        opts?.domain === "plans" ? [{ sha: `sha256:${"a".repeat(64)}`, bytes: 12, mtimeMs: 0 }] : [],
      deleteBlob: async (sha: string) => {
        deleted.push(sha);
      },
      graceMs: 0,
    } as unknown as CasGcOps;
    const base = deps({ actions: [] }).deps; // worktree finds nothing
    const out = await runRun(
      { component: "cas", apply: true, capability: "gc:delete" },
      { ...base, cas },
    );
    expect(out.status).toBe("swept");
    expect(out.reclaimed.map((f) => f.component)).toContain("cas");
    expect(deleted).toHaveLength(1);
  });

  test("run --all (no component) over the registry doesn't crash on the unregistered drivers", async () => {
    const out = await runRun({ apply: false }, deps({ actions: [dw()] }).deps);
    expect(out.status).toBe("would-sweep");
    expect(out.reclaimed).toHaveLength(1);
  });
});

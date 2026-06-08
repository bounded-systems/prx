/**
 * `prx gc <verb>` CLI surface (GH-2026/GH-2327; fan-out GH-2331).
 *
 * Exercises the argv parser and the dispatch wiring against the gc actor. All
 * three verbs are now wired: `inventory`/`run` fan out over the driver registry
 * (PR-1 registers the `worktree` driver), and `teardown` reuses the prune path.
 * Every verb runs offline via injected `buildParityChain`/`applyParityChainActions`
 * deps (the `chain(actions)` helper), so no test touches git.
 */
import { describe, expect, test } from "bun:test";

import type {
  SurfaceSyncAction,
  SurfaceSyncResult,
} from "@bounded-systems/surface-sync";

import {
  GcCliError,
  parseGcArgs,
  runGcCli,
  type GcCliDeps,
} from "../../../src/machine/gc/cli.ts";

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

/** Offline deps for every verb: `buildParityChain` returns a fixed chain;
 * `applyParityChainActions` records that it ran + yields per-action statuses. */
function gcDeps(
  actions: SurfaceSyncAction[],
  applyStatuses: number[] = [],
): GcCliDeps & { applied: boolean } {
  const state = { applied: false };
  return {
    cwd: "/tmp/gc-cli-test",
    buildParityChain: () => chain(actions),
    applyParityChainActions: (summary: SurfaceSyncResult) => {
      state.applied = true;
      return summary.actions.map((action, i) => ({
        action,
        command: `noop-${action.type}`,
        status: applyStatuses[i] ?? 0,
        stdout: "",
        stderr: "",
      }));
    },
    // Empty cas store so the cas driver finds nothing — keeps the suite hermetic
    // (else the CLI's real-cas fallback would enumerate the operator's env CAS).
    cas: {
      listRefs: async () => [],
      readBlob: async () => Buffer.from(""),
      listBlobs: async () => [],
      deleteBlob: async () => {},
      graceMs: 0,
    },
    // Empty repo-gc report so the repo driver finds nothing — same reason as cas
    // (else the CLI's real-runRepoGc fallback would scan the operator's inventory).
    repo: {
      run: () => ({
        apply: false,
        scanned: 0,
        orphansFound: 0,
        swept: 0,
        refused: 0,
        cleanedBytes: 0,
        durationMs: 0,
        entries: [],
      }),
    },
    get applied() {
      return state.applied;
    },
  } as GcCliDeps & { applied: boolean };
}

const deleteWorktree: SurfaceSyncAction = {
  type: "delete_worktree",
  branch: "GH-1234",
  ticket: "GH-1234",
  reason: "stale",
};
const deleteLocalBranch: SurfaceSyncAction = {
  type: "delete_local_branch",
  branch: "GH-1234",
  ticket: "GH-1234",
  reason: "merged",
};
const closeIssue: SurfaceSyncAction = {
  type: "close_issue",
  issue: 1234,
  ticket: "GH-1234",
  reason: "merged",
  pr: 99,
};

describe("parseGcArgs", () => {
  test("rejects empty argv", () => {
    expect(() => parseGcArgs([])).toThrow(GcCliError);
  });

  test("rejects unknown verbs", () => {
    expect(() => parseGcArgs(["bogus"])).toThrow(GcCliError);
  });

  test("run defaults apply=false; --apply flips it", () => {
    expect(parseGcArgs(["run"]).apply).toBe(false);
    expect(parseGcArgs(["run", "--apply"]).apply).toBe(true);
  });

  test("teardown takes a positional unit; --dry-run boolean", () => {
    const a = parseGcArgs(["teardown", "GH-1234", "--dry-run"]);
    expect(a.unit).toBe("GH-1234");
    expect(a.dryRun).toBe(true);
  });

  test("non-teardown verbs reject positionals", () => {
    expect(() => parseGcArgs(["inventory", "stray"])).toThrow();
  });
});

describe("runGcCli — inventory (sweep, read-only)", () => {
  test("nothing reclaimable → clean, exit 0", async () => {
    const r = await runGcCli(parseGcArgs(["inventory", "--format", "json"]), gcDeps([]));
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("clean");
    expect(payload.findings).toEqual([]);
  });

  test("a reclaimable worktree → reclaimable with an orphan finding", async () => {
    const r = await runGcCli(
      parseGcArgs(["inventory", "--component", "worktree", "--format", "json"]),
      gcDeps([deleteWorktree]),
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("reclaimable");
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({ component: "worktree", class: "orphan", ref: "GH-1234" });
  });
});

describe("runGcCli — run (sweep, dry-run by default, capability-gated)", () => {
  test("dry-run with a reclaimable worktree → would-sweep, dry_run:true, not applied", async () => {
    const deps = gcDeps([deleteWorktree]);
    const r = await runGcCli(parseGcArgs(["run", "--format", "json"]), deps);
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("would-sweep");
    expect(payload.dry_run).toBe(true);
    expect(payload.reclaimed).toHaveLength(1);
    expect(deps.applied).toBe(false);
  });

  test("--apply on a destructive component WITHOUT a token → capability-required, exit 1, not applied", async () => {
    const deps = gcDeps([deleteWorktree]);
    const r = await runGcCli(parseGcArgs(["run", "--apply", "--format", "json"]), deps);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("capability-required");
    expect(payload.reclaimed).toEqual([]);
    expect(deps.applied).toBe(false);
  });

  test("--apply --capability gc:delete → swept, exit 0, applied", async () => {
    const deps = gcDeps([deleteWorktree]);
    const r = await runGcCli(
      parseGcArgs(["run", "--apply", "--capability", "gc:delete", "--format", "json"]),
      deps,
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("swept");
    expect(payload.dry_run).toBe(false);
    expect(payload.reclaimed).toHaveLength(1);
    expect(deps.applied).toBe(true);
  });

  test("--apply --capability with nothing reclaimable → clean, exit 0", async () => {
    const deps = gcDeps([]);
    const r = await runGcCli(
      parseGcArgs(["run", "--apply", "--capability", "gc:delete", "--format", "json"]),
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.output).status).toBe("clean");
    expect(deps.applied).toBe(false);
  });

  test("plain format emits a gc.run header line", async () => {
    const r = await runGcCli(parseGcArgs(["run"]), gcDeps([deleteWorktree]));
    expect(r.output).toContain("gc.run: would-sweep");
    expect(r.output).toContain("dry_run=true");
  });
});

describe("runGcCli — teardown (targeted, acts by default)", () => {
  test("acts by default and tears down → torn-down, exit 0", async () => {
    const deps = gcDeps([deleteWorktree]);
    const r = await runGcCli(parseGcArgs(["teardown", "GH-1234", "--format", "json"]), deps);
    expect(deps.applied).toBe(true);
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("torn-down");
    expect(payload.removed).toEqual(["worktree"]);
  });

  test("--dry-run yields would-tear-down without applying, exit 0", async () => {
    const deps = gcDeps([deleteWorktree]);
    const r = await runGcCli(
      parseGcArgs(["teardown", "GH-1234", "--dry-run", "--format", "json"]),
      deps,
    );
    expect(deps.applied).toBe(false);
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("would-tear-down");
    expect(payload.removed).toEqual(["worktree"]);
  });

  test("no actions for the unit → not-found, exit 1", async () => {
    const deps = gcDeps([]);
    const r = await runGcCli(parseGcArgs(["teardown", "GH-9999", "--format", "json"]), deps);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("not-found");
    expect(payload.removed).toEqual([]);
  });

  test("an apply failure → partial, exit 1", async () => {
    const deps = gcDeps([deleteWorktree, deleteLocalBranch], [0, 1]);
    const r = await runGcCli(parseGcArgs(["teardown", "GH-1234", "--format", "json"]), deps);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.output);
    expect(payload.status).toBe("partial");
  });

  test("maps branch + gh-verified classes in stable order", async () => {
    const deps = gcDeps([closeIssue, deleteLocalBranch]);
    const r = await runGcCli(parseGcArgs(["teardown", "GH-1234", "--format", "json"]), deps);
    const payload = JSON.parse(r.output);
    // REMOVED_ORDER: worktree, beads, branch, gh-verified
    expect(payload.removed).toEqual(["branch", "gh-verified"]);
  });

  test("requires a unit positional", async () => {
    await expect(runGcCli({ verb: "teardown", format: "plain" })).rejects.toThrow(GcCliError);
  });
});

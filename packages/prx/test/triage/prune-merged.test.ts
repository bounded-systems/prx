// GH-1125 — `runPruneMergedActor` happy path + dry-run + no-op shapes.
// Mocks `buildParityChain`, `applyParityChainActions`, `pruneStaleRemoteRefs`,
// and `runBeadsSync` so the actor runs without touching gh, bd, or disk.
//
// GH-2316: the post-close reconcile now routes through the status-only
// canonical reconcile `runBeadsSync` (replacing the retired destructive
// `bd github sync --pull-only --prefer-github` shell-out), so a GH
// `priority::*` label can never round-trip into bd-canonical priority.

import { describe, expect, test } from "bun:test";

import { runPruneMergedActor } from "../../src/triage/prune-merged.ts";
import type { SurfaceSyncResult } from "@bounded-systems/surface-sync";
import type { ParityChainApplyResult } from "../../src/pr-state/cli-types.ts";
import { makeRunBeadsSyncMock } from "./sync-mock.ts";
import { invariantSpecs } from "@bounded-systems/machine-schema";

function chainWith(actions: SurfaceSyncResult["actions"]): SurfaceSyncResult {
  return {
    source: "surface-sync",
    repo: "owner/repo",
    mode: "prune",
    authority: "issue",
    scope: "all",
    apply: true,
    units: actions.map((action) => ({
      branch: action.type === "close_issue" ? `GH-${action.issue}` : action.branch,
      ticket: action.ticket,
      actions: [action],
    })),
    actions,
  };
}

describe("runPruneMergedActor — GH-1125", () => {
  test("no merged-PR-but-open-issue units → exitCode 0, no apply, no sync", async () => {
    const result = await runPruneMergedActor(
      { dryRun: false },
      {
        cwd: () => "/repo",
        pruneStaleRemoteRefs: () => undefined,
        buildParityChain: () => chainWith([]),
        applyParityChainActions: () => {
          throw new Error("must not apply when no actions");
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, () => {
          throw new Error("must not sync when no actions");
        }),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.closedIssues).toEqual([]);
    expect(result.removedWorktrees).toEqual([]);
    expect(result.applyResults).toEqual([]);
    expect(result.bdSync).toBeNull();
  });

  test("applies close_issue actions, mirrors closes via bd sync, returns issue numbers", async () => {
    const closeAction: SurfaceSyncResult["actions"][number] = {
      type: "close_issue",
      issue: 700,
      ticket: "GH-700",
      reason: "PR #1234 merged but issue still open",
      pr: 1234,
    };

    let refreshed = false;
    let synced = false;
    const result = await runPruneMergedActor(
      { dryRun: false },
      {
        cwd: () => "/repo",
        pruneStaleRemoteRefs: (cwd) => {
          expect(cwd).toBe("/repo");
          refreshed = true;
        },
        buildParityChain: (repo, opts) => {
          expect(repo).toBe("/repo");
          expect(opts?.mergedOnly).toBe(true);
          expect(opts?.mode).toBe("prune");
          expect(opts?.apply).toBe(true);
          return chainWith([closeAction]);
        },
        applyParityChainActions: (chain): ParityChainApplyResult[] => {
          expect(chain.actions).toHaveLength(1);
          return [
            {
              action: chain.actions[0]!,
              command: "gh issue close 700",
              status: 0,
              stdout: "",
              stderr: "",
            },
          ];
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0, stdout: "ok" }, () => {
          synced = true;
        }),
      },
    );
    expect(refreshed).toBe(true);
    expect(synced).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.closedIssues).toEqual([700]);
    expect(result.removedWorktrees).toEqual([]);
    expect(result.bdSync).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
  });

  test("dry-run lists what *would* close, does not apply, does not sync", async () => {
    const closeAction: SurfaceSyncResult["actions"][number] = {
      type: "close_issue",
      issue: 800,
      ticket: "GH-800",
      reason: "PR #2000 merged but issue still open",
      pr: 2000,
    };

    let refreshed = false;
    const result = await runPruneMergedActor(
      { dryRun: true },
      {
        cwd: () => "/repo",
        pruneStaleRemoteRefs: () => {
          refreshed = true;
        },
        buildParityChain: (_repo, opts) => {
          expect(opts?.apply).toBe(false);
          return chainWith([closeAction]);
        },
        applyParityChainActions: () => {
          throw new Error("dry-run must not apply");
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, () => {
          throw new Error("dry-run must not sync");
        }),
      },
    );
    // Dry-run skips the remote-ref refresh too; that's a write-path
    // optimization, not a discovery requirement.
    expect(refreshed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.closedIssues).toEqual([800]);
    expect(result.bdSync).toBeNull();
  });

  test("apply failure surfaces non-zero exit, no bd sync runs", async () => {
    const closeAction: SurfaceSyncResult["actions"][number] = {
      type: "close_issue",
      issue: 900,
      ticket: "GH-900",
      reason: "PR #3000 merged but issue still open",
      pr: 3000,
    };

    let synced = false;
    const result = await runPruneMergedActor(
      { dryRun: false },
      {
        cwd: () => "/repo",
        pruneStaleRemoteRefs: () => undefined,
        buildParityChain: () => chainWith([closeAction]),
        applyParityChainActions: (chain) => [
          {
            action: chain.actions[0]!,
            command: "gh issue close 900",
            status: 1,
            stdout: "",
            stderr: "permission denied",
          },
        ],
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, () => {
          synced = true;
        }),
      },
    );
    expect(result.exitCode).toBe(1);
    // Failed close → not in closedIssues; no bd sync to compound the noise.
    expect(result.closedIssues).toEqual([]);
    expect(synced).toBe(false);
    expect(result.bdSync).toBeNull();
  });

  // GH-1125 — Copilot review (PR #1135). The actor plans / applies / syncs
  // against `cwd`. If the operator passes `--repo <other/repo>` from a
  // checkout of a different repo, the rest of triage targets `<other/repo>`
  // (gh resolves repos from the directory) while this state would prune
  // and close issues in the *current* repo. Fail fast on mismatch instead
  // of silently diverging.
  test("fails fast when --repo does not match cwd-inferred repo", async () => {
    // GH-2316: runPruneMergedActor is async now, so the repo-mismatch guard
    // surfaces as a rejected promise rather than a synchronous throw.
    await expect(
      runPruneMergedActor(
        { repo: "owner/other-repo", dryRun: false },
        {
          cwd: () => "/repo/cwd",
          resolveRepoNameWithOwner: () => "owner/this-repo",
          pruneStaleRemoteRefs: () => {
            throw new Error("must not refresh on repo mismatch");
          },
          buildParityChain: () => {
            throw new Error("must not plan on repo mismatch");
          },
          applyParityChainActions: () => {
            throw new Error("must not apply on repo mismatch");
          },
          runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, () => {
            throw new Error("must not sync on repo mismatch");
          }),
        },
      ),
    ).rejects.toThrow(/owner\/other-repo.*owner\/this-repo/);
  });

  test("accepts --repo when it matches cwd-inferred repo", async () => {
    const result = await runPruneMergedActor(
      { repo: "owner/this-repo", dryRun: false },
      {
        cwd: () => "/repo/cwd",
        resolveRepoNameWithOwner: () => "owner/this-repo",
        pruneStaleRemoteRefs: () => undefined,
        buildParityChain: () => chainWith([]),
        applyParityChainActions: () => {
          throw new Error("must not apply when no actions");
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, () => {
          throw new Error("must not sync when no actions");
        }),
      },
    );
    expect(result.exitCode).toBe(0);
  });
});

// GH-1866 — Option-2 verification probe — RESOLVED by GH-2316.
//
// The 2026-05-16 stacking incident's root cause was that `diffRow` consulted
// the plan's bd-cache `currentLabels` for its per-axis gates, while bd often
// lagged GH on the type axis. The Option-1 fix fetches live GH labels at
// apply time and ignores the plan's bd snapshot for gating. That fix is
// sufficient on its own.
//
// The open question this probe documented was: does the sync that
// `pruneMergedActor` runs at the head of every triage pass mirror GH labels
// back into the bd cache? GH-2316 resolves it *architecturally* rather than
// empirically: `pruneMergedActor` no longer runs the destructive
// `bd github sync --pull-only --prefer-github` shell-out at all — it now
// chains the status-only canonical reconcile `runBeadsSync` (asserted below).
// `runBeadsSync`'s pull leg writes bd ONLY via status-close (execBdIssueClose,
// invariant I-DS-PRIO / I-DS2); it never writes labels or priority. So no
// triage-path reconcile mirrors GH labels into bd — Option-1's live-label
// fetch is permanently the authoritative source for diffRow gates, and
// Option-3 (trusting bd's label cache at classify time) is off the table.
//
// The narrower upstream question — what the external bd binary's `--pull-only`
// does with labels/priority in isolation — is now moot for the triage hot
// path; if ever needed it requires a live bd-CLI + GH harness (out of scope
// for a unit test) and is tracked as the GH-2316 Phase 1 follow-up.
describe("GH-1866 / GH-2316 — pruneMergedActor reconcile is status-only", () => {
  test("pruneMergedActor chains the status-only runBeadsSync, not the destructive pull-only shell-out", async () => {
    const closeAction: SurfaceSyncResult["actions"][number] = {
      type: "close_issue",
      issue: 4242,
      ticket: "GH-4242",
      reason: "PR #5151 merged but issue still open",
      pr: 5151,
    };
    const reconcileOpts: unknown[] = [];
    const result = await runPruneMergedActor(
      { dryRun: false },
      {
        cwd: () => "/repo",
        pruneStaleRemoteRefs: () => undefined,
        buildParityChain: () => chainWith([closeAction]),
        applyParityChainActions: (chain): ParityChainApplyResult[] => [
          {
            action: chain.actions[0]!,
            command: "gh issue close 4242",
            status: 0,
            stdout: "",
            stderr: "",
          },
        ],
        // Capture the reconcile opts to prove it's the `{ domain: "gh" }`
        // canonical-reconcile contract, never a `--pull-only` shell-out.
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, (opts) => {
          reconcileOpts.push(opts);
        }),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.closedIssues).toEqual([4242]);
    expect(reconcileOpts).toHaveLength(1);
    expect(reconcileOpts[0]).toMatchObject({ domain: "gh", dryRun: false });
  });

  test("I-DS-PRIO invariant is registered (no GH→bd path writes bd.priority)", () => {
    expect(invariantSpecs.some((s) => s.startsWith("I-DS-PRIO:"))).toBe(true);
  });
});

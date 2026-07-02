// Direct coverage for the pure `format*` projectors in cli-format.ts — these
// map a result object to a plain/json string and were previously only exercised
// incidentally through verb tests. Each case asserts both faces so the
// plain-text branch and the JSON branch are both reached.

import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  formatArtifactProjectedWorkUnitCheck,
  formatBeadsIssueMatches,
  formatGateResult,
  formatRemoteCiCheck,
  formatRepoOrigins,
  formatResolvedWorkUnitCheck,
  formatScoutLogs,
  formatSessionOpenCheck,
  formatTaskGraph,
  formatTaskStatus,
  formatVerbHelp,
  formatWorkUnitChainCheck,
  formatWorkUnitIssueCheck,
  formatWorkUnitSessionCheck,
  formatWorktreeRemove,
} from "../../src/pr-state/cli-format.ts";
import { createTaskContract } from "../../src/pr-state/task.ts";
import type { LocalRepo, RepoInventory } from "../../src/pr-state/repos.ts";

function taskInTmp(workUnitId = "GH-5431") {
  const root = mkdtempSync(join(tmpdir(), "cli-format-task-"));
  const cwd = join(root, workUnitId);
  mkdirSync(cwd);
  return createTaskContract({ workUnitId, worktree: cwd, beadId: "BEAD-7" });
}

describe("cli-format — work-unit checks", () => {
  test("formatWorkUnitIssueCheck renders json + plain", () => {
    const result = {
      workUnitId: "GH-1",
      repo: "owner/repo",
      issue: { number: 1, title: "a thing" },
    } as never;
    expect(JSON.parse(formatWorkUnitIssueCheck(result, "json"))).toMatchObject({
      workUnitId: "GH-1",
    });
    expect(formatWorkUnitIssueCheck(result, "plain")).toContain("Issue GH-1 is open in owner/repo");
  });

  test("formatResolvedWorkUnitCheck renders json (open reason) + plain (url location)", () => {
    const resolved = { source: "gh", title: "T", state: "open", url: "https://x/1" } as never;
    const json = JSON.parse(formatResolvedWorkUnitCheck("GH-1", resolved, "json"));
    expect(json).toMatchObject({ workUnitId: "GH-1", state: "open", reason: "open", valid: true });
    expect(formatResolvedWorkUnitCheck("GH-1", resolved, "plain")).toBe(
      "Issue GH-1 is open in https://x/1 (T).",
    );
  });

  test("formatResolvedWorkUnitCheck falls back to source when url is absent + non-open reason", () => {
    const resolved = { source: "bd", title: "T", state: "closed", url: null } as never;
    const json = JSON.parse(formatResolvedWorkUnitCheck("GH-2", resolved, "json"));
    expect(json.reason).toBe("closed");
    expect(formatResolvedWorkUnitCheck("GH-2", resolved, "plain")).toBe(
      "Issue GH-2 is closed in bd (T).",
    );
  });

  test("formatArtifactProjectedWorkUnitCheck renders json + plain", () => {
    expect(JSON.parse(formatArtifactProjectedWorkUnitCheck("GH-3", "json"))).toMatchObject({
      workUnitId: "GH-3",
      reason: "artifact_projected",
    });
    expect(formatArtifactProjectedWorkUnitCheck("GH-3", "plain")).toContain(
      "projected by a local CAS artifact",
    );
  });

  test("formatBeadsIssueMatches: json, id, empty, and a match listing", () => {
    const matches = [{ id: "bd-1", status: "open", title: "x" }] as never;
    expect(JSON.parse(formatBeadsIssueMatches(7, matches, "json"))).toHaveLength(1);
    expect(formatBeadsIssueMatches(7, matches, "id")).toBe("bd-1");
    expect(formatBeadsIssueMatches(7, [] as never, "plain")).toContain("No Beads issues linked");
    expect(formatBeadsIssueMatches(7, matches, "plain")).toBe("bd-1 [open] x");
  });

  test("formatWorkUnitSessionCheck: worktree present vs absent", () => {
    const withWt = { workUnitId: "GH-1", worktreePath: "/tmp/wt" } as never;
    expect(formatWorkUnitSessionCheck(withWt, "plain")).toContain("worktree /tmp/wt is not locked");
    const without = { workUnitId: "GH-1", worktreePath: null } as never;
    expect(formatWorkUnitSessionCheck(without, "plain")).toContain("no matching worktree");
    expect(JSON.parse(formatWorkUnitSessionCheck(withWt, "json"))).toMatchObject({
      workUnitId: "GH-1",
    });
  });

  test("formatWorkUnitChainCheck covers each pass reason", () => {
    const mk = (over: Record<string, unknown>) =>
      formatWorkUnitChainCheck({ workUnitId: "GH-1", ...over } as never, "plain");
    expect(mk({ reason: "missing_unit_allowed", issueAuthorityActive: true })).toContain(
      "can bootstrap this unit",
    );
    expect(mk({ reason: "missing_unit_allowed", issueAuthorityActive: false })).toContain(
      "pre-switch creation",
    );
    expect(mk({ reason: "artifact_projected" })).toContain("content-addressed plan artifact");
    expect(mk({ reason: "backfill_allowed" })).toContain("local backfill is still needed");
    expect(mk({ reason: "bd_schema_drift_detected" })).toContain("bd schema drift detected");
    expect(mk({ reason: "ok" })).toContain("no cleanup is required");
    expect(
      JSON.parse(formatWorkUnitChainCheck({ workUnitId: "GH-1", reason: "ok" } as never, "json")),
    ).toMatchObject({
      workUnitId: "GH-1",
    });
  });
});

describe("cli-format — gate / graph / task", () => {
  test("formatGateResult renders json + plain with reason and violations", () => {
    const result = {
      gate: "merge",
      pass: false,
      ref: "ref-1",
      derivationId: "deriv-1",
      verdict: { unit: "GH-1", subject: "sub", reason: "nope", violations: ["a", "b"] },
    } as never;
    expect(JSON.parse(formatGateResult(result, "json"))).toMatchObject({
      gate: "merge",
      pass: false,
    });
    const plain = formatGateResult(result, "plain");
    expect(plain).toContain("merge-gate: FAIL (GH-1)");
    expect(plain).toContain("reason:      nope");
    expect(plain).toContain("- a");
    expect(plain).toContain("- b");
  });

  test("formatGateResult plain omits reason/violations when absent", () => {
    const result = {
      gate: "ci",
      pass: true,
      ref: "r",
      derivationId: "d",
      verdict: { unit: "GH-1", subject: "s", reason: null, violations: [] },
    } as never;
    const plain = formatGateResult(result, "plain");
    expect(plain).toContain("ci-gate: PASS");
    expect(plain).not.toContain("reason:");
    expect(plain).not.toContain("violations:");
  });

  test("formatTaskGraph renders the ASCII machine + the json config", () => {
    expect(formatTaskGraph("plain")).toContain("Task Role Machine");
    expect(() => JSON.parse(formatTaskGraph("json"))).not.toThrow();
  });

  test("formatTaskStatus renders a freshly-created planning task (plain + json)", () => {
    const task = taskInTmp();
    const plain = formatTaskStatus(task, "plain");
    expect(plain).toContain("workUnit=GH-5431");
    expect(plain).toContain("currentRole=planner");
    expect(plain).toContain("confirmations=");
    expect(plain).toContain("signals=");
    expect(JSON.parse(formatTaskStatus(task, "json"))).toHaveProperty("status");
  });

  test("formatSessionOpenCheck with and without a task", () => {
    const task = taskInTmp("GH-5431");
    const withTask = {
      workUnitId: "GH-5431",
      localBranch: "GH-5431",
      remoteBranch: "origin/GH-5431",
      worktreePath: "/tmp/wt",
      taskContract: true,
      task,
    } as never;
    const plain = formatSessionOpenCheck(withTask, "plain");
    expect(plain).toContain("workUnit=GH-5431");
    expect(plain).toContain("currentRole=planner");
    expect(JSON.parse(formatSessionOpenCheck(withTask, "json"))).toMatchObject({
      workUnitId: "GH-5431",
    });

    const noTask = {
      workUnitId: "GH-9",
      localBranch: "GH-9",
      remoteBranch: null,
      worktreePath: null,
      taskContract: false,
      task: null,
    } as never;
    const plainNo = formatSessionOpenCheck(noTask, "plain");
    expect(plainNo).toContain("worktreePath=none");
    expect(plainNo).not.toContain("currentRole=");
  });
});

describe("cli-format — worktree / ci surfaces", () => {
  test("formatWorktreeRemove: dry-run and removed-with-branch-deleted", () => {
    const dry = {
      target: "GH-1",
      path: "/tmp/GH-1",
      branch: "GH-1",
      force: false,
      prune: true,
      deleteBranch: false,
      dryRun: true,
      branchDeleted: false,
    } as never;
    const dryOut = formatWorktreeRemove(dry, "plain");
    expect(dryOut).toContain("result=dry-run");
    expect(dryOut).not.toContain("branch_result=");

    const removed = {
      target: "GH-1",
      path: "/tmp/GH-1",
      branch: null,
      force: true,
      prune: false,
      deleteBranch: true,
      dryRun: false,
      branchDeleted: true,
    } as never;
    const out = formatWorktreeRemove(removed, "plain");
    expect(out).toContain("branch=detached");
    expect(out).toContain("result=removed");
    expect(out).toContain("branch_result=deleted");
    expect(JSON.parse(formatWorktreeRemove(removed, "json"))).toMatchObject({ target: "GH-1" });
  });

  test("formatRemoteCiCheck: clean and a failing check with codebuild detail", () => {
    const clean = { repoPath: "/r", pr: 5, failingChecks: [] } as never;
    expect(formatRemoteCiCheck(clean, "plain")).toContain("no failing checks");

    const failing = {
      repoPath: "/r",
      pr: 7,
      failingChecks: [
        {
          name: "ci",
          state: "FAILURE",
          description: "boom",
          link: "https://x",
          codebuild: {
            buildId: "b-1",
            reportArn: "arn:1",
            error: null,
            failures: [{ test: "t1" }, { test: "t2" }],
          },
        },
      ],
    } as never;
    const out = formatRemoteCiCheck(failing, "plain");
    expect(out).toContain("- ci [FAILURE]");
    expect(out).toContain("description: boom");
    expect(out).toContain("codebuild: b-1");
    expect(out).toContain("report: arn:1");
    expect(out).toContain("failed_tests: 2");
    expect(JSON.parse(formatRemoteCiCheck(failing, "json"))).toMatchObject({ pr: 7 });
  });

  test("formatScoutLogs: clean and a check carrying log output", () => {
    const clean = { pr: 1, checks: [] } as never;
    expect(formatScoutLogs(clean, "plain")).toContain("no failing checks — CI is clean");

    const withLogs = {
      pr: 9,
      checks: [
        {
          name: "build",
          state: "FAILURE",
          link: "https://l",
          runId: "r-1",
          error: "nope",
          logs: "line1\nline2",
        },
      ],
    } as never;
    const out = formatScoutLogs(withLogs, "plain");
    expect(out).toContain("=== build [FAILURE] ===");
    expect(out).toContain("run_id: r-1");
    expect(out).toContain("error: nope");
    expect(out).toContain("--- log output ---");
    expect(out).toContain("line2");
    expect(JSON.parse(formatScoutLogs(withLogs, "json"))).toMatchObject({ pr: 9 });
  });
});

describe("cli-format — verb help", () => {
  test("formatVerbHelp falls back to the overview for an unknown verb", () => {
    // An unknown verb returns the general help overview (non-empty).
    expect(formatVerbHelp("definitely-not-a-real-verb").length).toBeGreaterThan(0);
  });

  test("formatVerbHelp renders a header + footer for a known verb", () => {
    // `next` is a stable top-level verb; the header echoes the resolved name
    // and the body carries the standard footer.
    const help = formatVerbHelp("next");
    expect(help).toContain("prx next");
    expect(help).toContain("domain:");
    expect(help).toContain("Run `prx help-all`");
  });
});

describe("cli-format — repo origins", () => {
  function repo(name: string, remotes: LocalRepo["remotes"]): LocalRepo {
    return {
      name,
      commonDir: `/bare/${name}.git`,
      kind: "bare",
      mainWorktree: null,
      worktrees: [],
      localOnlyBranches: [],
      findings: [],
      remotes,
      primaryRemote: remotes[0] ?? null,
      upstreamRemote: null,
    };
  }

  test("formatRepoOrigins dedupes, sorts, and keys on the remote literally named origin", () => {
    const inventory: RepoInventory = {
      roots: [],
      repos: [
        repo("b-repo", [{ name: "origin", url: "https://github.com/b/repo.git", githubRepo: "b/repo" }]),
        repo("a-repo", [{ name: "origin", url: "https://github.com/a/repo.git", githubRepo: "a/repo" }]),
        // Duplicate origin URL (e.g. two worktrees of the same repo) collapses.
        repo("b-repo-dup", [{ name: "origin", url: "https://github.com/b/repo.git", githubRepo: "b/repo" }]),
        // Only a "local" buffer remote, no real origin — must be excluded, not
        // fall back to it the way `primaryRemote` would.
        repo("local-only", [{ name: "local", url: "file:///buffer/local-only.git", githubRepo: null }]),
        // No remotes at all.
        repo("no-remotes", []),
      ],
    };
    const plain = formatRepoOrigins(inventory, "plain");
    expect(plain.split("\n")).toEqual([
      "https://github.com/a/repo.git",
      "https://github.com/b/repo.git",
    ]);
    const json = JSON.parse(formatRepoOrigins(inventory, "json"));
    expect(json).toEqual(["https://github.com/a/repo.git", "https://github.com/b/repo.git"]);
  });

  test("formatRepoOrigins on an empty inventory", () => {
    const inventory: RepoInventory = { roots: [], repos: [] };
    expect(formatRepoOrigins(inventory, "plain")).toBe("");
    expect(JSON.parse(formatRepoOrigins(inventory, "json"))).toEqual([]);
  });
});

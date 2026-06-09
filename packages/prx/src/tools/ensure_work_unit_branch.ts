/**
 * ensure-work-unit-branch — idempotently enforce the branch + upstream
 * invariants that `prx session open` requires before a worktree is
 * materialized for a work unit id.
 *
 * Invariants enforced, in order:
 *   1. refs/remotes/origin/<id> exists on the remote
 *      (delegated to ensureBranch, which pushes <base> to origin/<id>
 *       when missing).
 *   2. refs/heads/<id> exists locally AND its upstream is origin/<id>.
 *
 * Does NOT touch worktrees or run `wt switch`. Its output is the branch
 * state that downstream worktree creation assumes.
 *
 * Callers:
 *   - src/pr-state/cli.ts :: materializeWorkUnitBranch — before worktree
 *     placement, so an existing local branch can be attached to a worktree
 *     without --create and without losing upstream tracking.
 *   (prx-arl removed the worktrunk pre-switch `prx tools wt ensure-branch`
 *    caller, GH-531 — prx owns the worktree lifecycle now.)
 *
 * When a spawn injector is provided (tests, or the materialize flow
 * threading its SpawnLike through), every git call uses it. Otherwise
 * reads go through execGit (policy-enforced) and writes use spawnCapture
 * (GH-1609), matching the ensure_branch.ts convention.
 */

import { spawnCapture } from "@bounded-systems/proc";
import {
  ensureBranch,
  type EnsureBranchResult,
  type EnsureBranchSpawnLike,
} from "./ensure_branch.ts";
import { execGit } from "@bounded-systems/git";

type GitResult = { exitCode: number; stdout: string; stderr: string };

function runGit(
  spawn: EnsureBranchSpawnLike | undefined,
  subcommand: string,
  args: readonly string[],
  cwd: string,
): GitResult {
  if (spawn) {
    const r = spawn("git", ["-C", cwd, subcommand, ...args], { cwd, encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  const r = execGit({ subcommand, args: [...args], cwd });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

function writeGit(
  spawn: EnsureBranchSpawnLike | undefined,
  args: readonly string[],
  cwd: string,
): GitResult {
  if (spawn) {
    const r = spawn("git", ["-C", cwd, ...args], { cwd, encoding: "utf8" });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  const r = spawnCapture(["git", "-C", cwd, ...args]);
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export type EnsureWorkUnitBranchStatus =
  | "skipped"
  | "ok"
  | "created-tracking"
  | "upstream-fixed"
  | "upstream-mismatch"
  | "error";

export type EnsureWorkUnitBranchResult = {
  status: EnsureWorkUnitBranchStatus;
  id: string;
  upstream: string;
  remote: EnsureBranchResult;
  localCreated: boolean;
  upstreamChanged: boolean;
  message?: string | undefined;
};

export type EnsureWorkUnitBranchOptions = {
  id: string;
  base?: string;
  cwd?: string;
  skip?: readonly string[];
  /** Optional spawn injector for tests. Defaults to the @bounded-systems/proc spawn. */
  spawn?: EnsureBranchSpawnLike;
};

export function ensureWorkUnitBranchAndUpstream(
  opts: EnsureWorkUnitBranchOptions,
): EnsureWorkUnitBranchResult {
  const cwd = opts.cwd ?? process.cwd();
  const id = opts.id;
  const upstream = `origin/${id}`;
  const spawn = opts.spawn;

  const remote = ensureBranch({
    name: id,
    base: opts.base,
    skip: opts.skip,
    cwd,
    spawn,
  });

  if (remote.status === "skipped") {
    return {
      status: "skipped",
      id,
      upstream,
      remote,
      localCreated: false,
      upstreamChanged: false,
    };
  }
  if (remote.status === "error" || remote.status === "base-unresolved") {
    return {
      status: "error",
      id,
      upstream,
      remote,
      localCreated: false,
      upstreamChanged: false,
      message: remote.message,
    };
  }

  const originRef = runGit(spawn, "rev-parse", ["--verify", "--quiet", `refs/remotes/origin/${id}`], cwd);
  if (originRef.exitCode !== 0) {
    return {
      status: "error",
      id,
      upstream,
      remote,
      localCreated: false,
      upstreamChanged: false,
      message: `origin/${id} not found after ensureBranch returned ${remote.status}`,
    };
  }

  const localRef = runGit(spawn, "rev-parse", ["--verify", "--quiet", `refs/heads/${id}`], cwd);

  if (localRef.exitCode !== 0) {
    const create = writeGit(spawn, ["branch", "--track", id, `origin/${id}`], cwd);
    if (create.exitCode !== 0) {
      return {
        status: "error",
        id,
        upstream,
        remote,
        localCreated: false,
        upstreamChanged: false,
        message:
          create.stderr.trim()
            || `git branch --track ${id} origin/${id} failed (exit ${create.exitCode})`,
      };
    }
    return {
      status: "created-tracking",
      id,
      upstream,
      remote,
      localCreated: true,
      upstreamChanged: false,
    };
  }

  const upstreamCheck = runGit(spawn, "branch", ["--list", id, "--format=%(upstream:short)"], cwd);
  const currentUpstream = upstreamCheck.stdout.trim();

  if (currentUpstream === upstream) {
    return {
      status: "ok",
      id,
      upstream,
      remote,
      localCreated: false,
      upstreamChanged: false,
    };
  }

  if (currentUpstream.length > 0) {
    return {
      status: "upstream-mismatch",
      id,
      upstream,
      remote,
      localCreated: false,
      upstreamChanged: false,
      message: `branch ${id} upstream is ${currentUpstream}, expected ${upstream}`,
    };
  }

  const setUpstream = writeGit(spawn, ["branch", `--set-upstream-to=origin/${id}`, id], cwd);
  if (setUpstream.exitCode !== 0) {
    return {
      status: "error",
      id,
      upstream,
      remote,
      localCreated: false,
      upstreamChanged: false,
      message:
        setUpstream.stderr.trim()
          || `git branch --set-upstream-to=origin/${id} ${id} failed (exit ${setUpstream.exitCode})`,
    };
  }
  return {
    status: "upstream-fixed",
    id,
    upstream,
    remote,
    localCreated: false,
    upstreamChanged: true,
  };
}

export function formatEnsureWorkUnitBranchResult(
  result: EnsureWorkUnitBranchResult,
  format: "plain" | "json",
): string {
  if (format === "json") return JSON.stringify(result, null, 2);

  const tag =
    result.status === "ok" ? "ok"
    : result.status === "skipped" ? "skipped"
    : result.status === "created-tracking" ? "created-tracking"
    : result.status === "upstream-fixed" ? "upstream-fixed"
    : result.status === "upstream-mismatch" ? "upstream-mismatch"
    : "error";

  let line = `${tag}: ${result.id} -> ${result.upstream}`;
  if (result.message) line += ` — ${result.message}`;
  return line;
}
